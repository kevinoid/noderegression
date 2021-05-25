/**
 * @copyright Copyright 2017-2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @module noderegression/cli.js
 */

'use strict';

const { Command, InvalidOptionArgumentError } = require('commander');
const fetch = require('node-fetch');
// TODO [engine:node@>=14]: import { readFile } from 'fs/promises'
// https://github.com/mysticatea/eslint-plugin-node/issues/174
// eslint-disable-next-line node/no-unsupported-features/node-builtins
const { createWriteStream, promises: fsPromises } = require('fs');
const path = require('path');
const { finished } = require('stream');

const { bisectRange } = require('./index.js');
const parseBuildVersion = require('./lib/parse-build-version.js');

const { readFile } = fsPromises;

function finishedErrorOk(stream, options) {
  return new Promise((resolve) => {
    finished(stream, options, resolve);
  });
}

function buildToString(build) {
  if (!build) {
    return 'None found';
  }

  const {
    year,
    month,
    day,
    commit,
  } = parseBuildVersion(build.version);

  return `${commit} on ${year}-${
    String(month).padStart(2, '0')}-${
    String(day).padStart(2, '0')}`;
}

/** Option parser to combine multiple occurrences occurrences of an option
 * into an Array.
 *
 * @private
 * @param {string} optarg Argument passed to option.
 * @param {Array<string>=} previous Previous values of option.
 * @returns {!Array<string>} optarg concatenated to previous.
 */
function arrayOption(optarg, previous) {
  return [...previous || [], optarg];
}

/** Option parser to count the number of occurrences of the option.
 *
 * @private
 * @param {boolean|string} optarg Argument passed to option (ignored).
 * @param {number=} previous Previous value of option (counter).
 * @returns {number} previous + 1.
 */
function countOption(optarg, previous) {
  return (previous || 0) + 1;
}

function parseDate(str) {
  let date = new Date(str);
  const dateMs = date.getTime();
  if (Number.isNaN(dateMs)) {
    throw new InvalidOptionArgumentError(`Invalid Date: ${str}`);
  }

  const dayMs = dateMs % (24 * 60 * 60 * 1000);
  if (dayMs !== 0) {
    const dayMins = dayMs / (60 * 1000);
    if (dayMins !== date.getTimezoneOffset()) {
      // Accepting time leads to too many ambiguities and potential errors.
      // (e.g. 'YYYY-MM-DD' parsed as UTC, 'MM/DD/YYYY' parsed as local time)
      // Build time is not known (currently treated as midnight UTC, which
      // may not match user expectations).
      throw new InvalidOptionArgumentError(
        `Date with time not supported: ${str}`,
      );
    }

    date = new Date(dateMs - dayMs);
  }

  return date;
}

async function readJson(pathOrUrl, options) {
  const content = await readFile(pathOrUrl, { encoding: 'utf8', ...options });
  return JSON.parse(content);
}

/** Options for command entry points.
 *
 * @typedef {{
 *   env: object<string,string>|undefined,
 *   stdin: !module:stream.Readable,
 *   stdout: !module:stream.Writable,
 *   stderr: !module:stream.Writable
 * }} CommandOptions
 * @property {object<string,string>=} env Environment variables.
 * @property {!module:stream.Readable} stdin Stream from which input is read.
 * @property {!module:stream.Writable} stdout Stream to which output is
 * written.
 * @property {!module:stream.Writable} stderr Stream to which errors and
 * non-output status messages are written.
 */
// const CommandOptions;

/** Entry point for this command.
 *
 * @param {Array<string>} args Command-line arguments.
 * @param {!CommandOptions} options Options.
 * @param {function(number)} callback Callback with exit code.
 */
function noderegressionCmd(args, options, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('callback must be a function');
  }

  if (!Array.isArray(args) || args.length < 2) {
    throw new TypeError('args must be an Array with at least 2 items');
  }

  if (!options || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }

  if (!options.stdin || typeof options.stdin.on !== 'function') {
    throw new TypeError('options.stdin must be a stream.Readable');
  }
  if (!options.stdout || typeof options.stdout.write !== 'function') {
    throw new TypeError('options.stdout must be a stream.Writable');
  }
  if (!options.stderr || typeof options.stderr.write !== 'function') {
    throw new TypeError('options.stderr must be a stream.Writable');
  }

  // Temporary workaround to minimize diff for Promise conversion.
  // eslint-disable-next-line
  noderegressionMain(args, options).then(callback);
}

async function noderegressionMain(args, options) {
  let good;
  function parseGood(optarg) {
    const date = parseDate(optarg);
    if (!good || good.getTime() < date.getTime()) {
      good = date;
    }
  }

  let bad;
  function parseBad(optarg) {
    const date = parseDate(optarg);
    if (!bad || bad.getTime() > date.getTime()) {
      bad = date;
    }
  }

  let errVersion;
  const command = new Command()
    .exitOverride()
    .configureOutput({
      writeOut: (str) => options.stdout.write(str),
      writeErr: (str) => options.stderr.write(str),
      getOutHelpWidth: () => options.stdout.columns,
      getErrHelpWidth: () => options.stderr.columns,
    })
    .arguments('<test_command...>')
    .usage('[options] -- <test_command...>')
    .allowExcessArguments(false)
    // Stop parsing at first non-option.
    // https://github.com/tj/commander.js/issues/1127#issuecomment-754230279
    .passThroughOptions()
    // Check for required/excess arguments.
    // Workaround https://github.com/tj/commander.js/issues/1493
    // TODO [commander@>=8]: Remove if fixed
    .action(() => {})
    .description('Reduce a regression range using Node.js nightly builds.')
    .option('-b, --bad <date>', 'first date when issue was present', parseBad)
    // Note: can't alias options or add additional long name
    // https://github.com/tj/commander.js/issues/479
    .option('--new <date>', 'alias for --bad', parseBad)
    .option(
      '-g, --good <date>',
      'last date when issue was not present',
      parseGood,
    )
    // Note: can't alias options or add additional long name
    // https://github.com/tj/commander.js/issues/479
    .option('--old <date>', 'alias for --good', parseGood)
    .option('-l, --log <logfile>', 'save git bisect log to file', arrayOption)
    .option('-q, --quiet', 'print less output', countOption)
    .option(
      '-t, --target <target>',
      'build files to test (preferred first, if used multiple times)',
      arrayOption,
    )
    .option('-v, --verbose', 'print more output', countOption)
    // TODO: Replace with .version(packageJson.version) loaded as JSON module
    // https://github.com/nodejs/node/issues/37141
    .option('-V, --version', 'output the version number')
    // throw exception to stop option parsing early, as commander does
    // (e.g. to avoid failing due to missing required arguments)
    .on('option:version', () => {
      errVersion = new Error('version');
      throw errVersion;
    });

  try {
    command.parse(args);
  } catch (errParse) {
    if (errVersion) {
      const packageJson =
        await readJson(path.join(__dirname, 'package.json'));
      options.stdout.write(`${packageJson.version}\n`);
      return 0;
    }

    // Note: Error message already printed to stderr by Commander
    return errParse.exitCode !== undefined ? errParse.exitCode : 1;
  }

  const argOpts = command.opts();

  let exitCode = 0;
  const logsFinished = [];
  const logsOpen = [];
  const bisectLogs = [];
  function onBisectLogError(errLog) {
    exitCode = 1;
    options.stderr.write(`Error writing to bisect log: ${errLog}\n`);

    // Not writable after error due to autoDestroy.  Remove.
    const i = bisectLogs.indexOf(this);
    if (i >= 0) {
      bisectLogs.splice(i, 1);
    }
  }
  for (const logName of argOpts.log || []) {
    let bisectLog;
    if (logName === '-') {
      bisectLog = options.stdout;
      bisectLog.on('error', onBisectLogError);
    } else {
      bisectLog = createWriteStream(logName);

      // Promise for 'open' or 'error'
      // 'error' after 'open' handled by onBisectLogError
      logsOpen.push(new Promise((resolve, reject) => {
        bisectLog.once('open', () => {
          bisectLog.on('error', onBisectLogError);
          resolve();
        });
        bisectLog.once('error', reject);
      }));

      // Note: finished not reliable after 'error'.  Register early.
      // https://github.com/nodejs/node/issues/34108
      // Note: 'error' handled above, ignore for finish.
      logsFinished.push(finishedErrorOk(bisectLog));
    }
    bisectLogs.push(bisectLog);
  }

  const verbosity = (argOpts.verbose || 0) - (argOpts.quiet || 0);
  // eslint-disable-next-line no-console
  const logger = new console.Console(options.stderr);
  if (verbosity < -1) { logger.warn = () => {}; }
  if (verbosity < 0) { logger.info = () => {}; }
  if (verbosity < 1) { logger.debug = () => {}; }

  // Parse arguments then call API function with parsed options
  const cmdOpts = {
    console: logger,
    env: options.env,
    fetch: verbosity < 0 ? fetch : (reqInfo, reqInit) => {
      options.stderr.write(`Downloading ${reqInfo.url || reqInfo}...\n`);
      // Note: Logging progress information is difficult.  See:
      // https://github.com/node-fetch/node-fetch/issues/427
      // https://github.com/whatwg/fetch/issues/607#issuecomment-564461907
      // (Does not work correctly for responses with Content-Encoding.)
      return fetch(reqInfo, reqInit);
    },
    listeners: {
      onrange: (low, high) => {
        if (verbosity >= 0) {
          const count = high - low + 1;
          const steps = Math.ceil(Math.log2(count)) + 1;
          options.stderr.write(
            `${count} builds left to test (~${steps} steps)\n`,
          );
        }
      },
      onresult: (build, code, signal) => {
        const goodbad = code === 0 ? 'good' : 'bad';
        if (verbosity >= 1) {
          const exitStr =
            signal ? `killed by ${signal}` : `exit code ${code}`;
          options.stderr.write(
            `Build ${build.version} ${exitStr} (${goodbad})\n`,
          );
        }

        const { commit } = parseBuildVersion(build.version);
        for (const bisectLog of bisectLogs) {
          // Output progress in format compatible with `git bisect log`
          bisectLog.write(
            `# ${goodbad}: ${build.version}\n`
            + `git bisect ${goodbad} ${commit}\n`,
          );
        }
      },
    },
    targets: argOpts.target,
  };
  let openingLogs = true;
  try {
    // Ensure log files can be opened before bisecting
    if (logsOpen.length > 0) {
      await Promise.all(logsOpen);
    }
    openingLogs = false;

    const bisectRange2 = options.bisectRange || bisectRange;
    const [goodBuild, badBuild] =
      await bisectRange2(good, bad, command.args, cmdOpts);
    if (verbosity >= 0) {
      options.stderr.write(`Last good build: ${buildToString(goodBuild)}\n`);
      options.stderr.write(`First bad build: ${buildToString(badBuild)}\n`);
    }
  } catch (err2) {
    exitCode = 1;
    options.stderr.write(
      openingLogs ? `Error opening log file: ${err2}`
        : `Unhandled exception:\n${err2.stack}\n`,
    );
  } finally {
    for (const bisectLog of bisectLogs) {
      if (bisectLog !== options.stdout) {
        bisectLog.end();
      }
    }

    await logsFinished;
  }

  return exitCode;
}

module.exports = noderegressionCmd;
