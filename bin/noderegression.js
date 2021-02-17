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
const stream = require('stream');
const { promisify } = require('util');

const { bisectRange } = require('..');
const packageJson = require('../package.json');

// TODO [engine:node@>=15]: Use finished from 'streams/promise'
const finished = promisify(stream.finished);

function buildToString(build) {
  if (!build) {
    return 'None found';
  }
  return `${build.commit} on ${build.date}`;
}

function coerceDateUTC(str) {
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid Date: ${str}`);
  }
  return new Date(date.getTime() + date.getTimezoneOffset() * 60000);
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
      'duplicate-arguments-array': false,
      'flatten-duplicate-arrays': false,
      'greedy-arrays': false,
    })
    .usage('Usage: $0 [options] -- <node args...>')
    .help()
    .alias('help', 'h')
    .alias('help', '?')
    .option('bad', {
      alias: ['b', 'new'],
      coerce: coerceDateUTC,
      describe: 'first date when issue was present',
    })
    .option('good', {
      alias: ['g', 'old'],
      coerce: coerceDateUTC,
      describe: 'last date when issue was not present',
    })
    .option('log', {
      alias: 'l',
      describe: 'save git bisect log to file',
    })
    .option('quiet', {
      alias: 'q',
      describe: 'Print less output',
      count: true,
    })
    .option('target', {
      alias: 't',
      describe: 'Build target name(s) in preference order',
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

    let exitCode = 0;
    let bisectLog;
    if (argOpts.log === '-') {
      bisectLog = options.stdout;
    } else if (argOpts.log) {
      bisectLog = fs.createWriteStream(argOpts.log);
      bisectLog.on('error', (errLog) => {
        exitCode = 1;
        options.stderr.write(`Error writing to bisect log: ${errLog}\n`);
      });
    }

    // Parse arguments then call API function with parsed options
    const cmdOpts = {
      env: options.env,
      fetch: options.verbosity < 0 ? fetch : (reqInfo, reqInit) => {
        options.stderr.write(`Downloading ${reqInfo.url || reqInfo}...\n`);
        return fetch(reqInfo, reqInit);
      },
      listeners: {
        onrange: (low, high) => {
          if (options.verbosity >= 0) {
            const count = high - low + 1;
            const steps = Math.ceil(Math.log2(count)) + 1;
            options.stderr.write(
              `${count} builds left to test (~${steps} steps)\n`,
            );
          }
        },
        onresult: (build, code, signal) => {
          const goodbad = code === 0 ? 'good' : 'bad';
          if (options.verbosity >= 1) {
            const exitStr =
              signal ? `killed by ${signal}` : `exit code ${code}`;
            options.stderr.write(
              `Build ${build.version} ${exitStr} (${goodbad})\n`,
            );
          }
          if (bisectLog) {
            // Output progress in format compatible with `git bisect log`
            bisectLog.write(
              `# ${goodbad}: ${build.version}\n`
              + `git bisect ${goodbad} ${build.commit}\n`,
            );
          }
        },
      },
      targets: argOpts.target,
      stderr: options.stderr,
      stdout: options.stdout,
      verbosity: argOpts.verbose - argOpts.quiet,
    };
    try {
      const [goodBuild, badBuild] =
        await bisectRange(argOpts.good, argOpts.bad, argOpts._, cmdOpts);
      options.stderr.write(`Last good build: ${buildToString(goodBuild)}\n`);
      options.stderr.write(`First bad build: ${buildToString(badBuild)}\n`);
    } catch (err2) {
      exitCode = 1;
      options.stderr.write(`Unhandled exception:\n${err2.stack}\n`);
    } finally {
      if (bisectLog && bisectLog !== options.stdout) {
        bisectLog.end();
        try {
          await finished(bisectLog);
        } catch {
          // error already logged from 'error' event
        }
      }
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
