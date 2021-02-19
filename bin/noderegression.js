#!/usr/bin/env node
/**
 * Use binary search to find Node.js build which introduced a bug.
 * Node.js analog to mozregression.
 *
 * @copyright Copyright 2017-2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @module noderegression/bin/noderegression
 */

'use strict';

const Yargs = require('yargs/yargs');
const fetch = require('node-fetch');
const fs = require('fs');
const { finished } = require('stream');

const { bisectRange } = require('..');
const packageJson = require('../package.json');
const parseBuildVersion = require('../lib/parse-build-version.js');

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

function coerceDate(str) {
  let date = new Date(str);
  const dateMs = date.getTime();
  if (Number.isNaN(dateMs)) {
    throw new TypeError(`Invalid Date: ${str}`);
  }

  const dayMs = dateMs % (24 * 60 * 60 * 1000);
  if (dayMs !== 0) {
    const dayMins = dayMs / (60 * 1000);
    if (dayMins !== date.getTimezoneOffset()) {
      // Accepting time leads to too many ambiguities and potential errors.
      // (e.g. 'YYYY-MM-DD' parsed as UTC, 'MM/DD/YYYY' parsed as local time)
      // Build time is not known (currently treated as midnight UTC, which
      // may not match user expectations).
      throw new RangeError(`Date with time not supported: ${str}`);
    }

    date = new Date(dateMs - dayMs);
  }

  return date;
}

function coerceDateOrArray(strOrArray) {
  return Array.isArray(strOrArray) ? strOrArray.map(coerceDate)
    : coerceDate(strOrArray);
}

function ensureArray(val) {
  return val === undefined || val === null ? []
    : Array.isArray(val) ? val
      : [val];
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

  if (args !== undefined
      && args !== null
      && Math.floor(args.length) !== args.length) {
    throw new TypeError('args must be Array-like');
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

  if (args.length >= 2) {
    // Strip "node" and script name, ensure args are strings
    args = Array.prototype.slice.call(args, 2).map(String);
  } else {
    args = [];
  }

  const yargs = new Yargs()
    .parserConfiguration({
      'parse-numbers': false,
      'parse-positional-numbers': false,
      'duplicate-arguments-array': true,
      'flatten-duplicate-arrays': false,
      'greedy-arrays': false,
      'halt-at-non-option': true,
    })
    .usage('Usage: $0 [options] -- <node args...>')
    .help()
    .alias('help', 'h')
    .alias('help', '?')
    .option('bad', {
      alias: ['b', 'new'],
      coerce: coerceDateOrArray,
      describe: 'first date when issue was present',
      nargs: 1,
    })
    .option('good', {
      alias: ['g', 'old'],
      coerce: coerceDateOrArray,
      describe: 'last date when issue was not present',
      nargs: 1,
    })
    .option('log', {
      alias: 'l',
      describe: 'save git bisect log to file',
      nargs: 1,
    })
    .option('quiet', {
      alias: 'q',
      describe: 'Print less output',
      count: true,
    })
    .option('target', {
      alias: 't',
      describe: 'Build files to test.  '
        + 'May be given multiple times in preference order.',
      nargs: 1,
    })
    .option('verbose', {
      alias: 'v',
      describe: 'Print more output',
      count: true,
    })
    .version(`${packageJson.name} ${packageJson.version}`)
    .alias('version', 'V')
    .strict();
  yargs.parse(args, async (errYargs, argOpts, output) => {
    if (errYargs) {
      options.stderr.write(`${output || errYargs}\n`);
      callback(1);
      return;
    }

    if (output) {
      options.stdout.write(`${output}\n`);
    }

    if (argOpts.help || argOpts.version) {
      callback(0);
      return;
    }

    if (argOpts._.length === 0) {
      options.stderr.write('Error: Must specify a test command to run.\n');
      callback(1);
      return;
    }

    // Only need last good and first bad dates for bisecting.
    const good =
      Array.isArray(argOpts.good) ? new Date(Math.max(...argOpts.good))
        : argOpts.good;
    const bad =
      Array.isArray(argOpts.bad) ? new Date(Math.min(...argOpts.bad))
        : argOpts.bad;

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
    for (const logName of ensureArray(argOpts.log)) {
      let bisectLog;
      if (logName === '-') {
        bisectLog = options.stdout;
        bisectLog.on('error', onBisectLogError);
      } else {
        bisectLog = fs.createWriteStream(logName);

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

    const verbosity = argOpts.verbose - argOpts.quiet;
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
      targets:
        argOpts.target !== undefined ? ensureArray(argOpts.target) : undefined,
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
        await bisectRange2(good, bad, argOpts._, cmdOpts);
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

    callback(exitCode);
  });
}

module.exports = noderegressionCmd;

if (require.main === module) {
  // This file was invoked directly.
  // Note:  Could pass process.exit as callback to force immediate exit.
  noderegressionCmd(process.argv, process, (exitCode) => {
    process.exitCode = exitCode;
  });
}
