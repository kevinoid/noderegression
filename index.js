/**
 * Use binary search to find Node.js build which introduced a bug.
 * Node.js analog to mozregression.
 *
 * @copyright Copyright 2016-2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @module noderegression
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Agent: HttpAgent } = require('http');
const { Agent: HttpsAgent } = require('https');
const os = require('os');
const path = require('path');
const { debuglog, promisify } = require('util');

const binarySearchAsync = require('./lib/binary-search-async.js');
const getBuildList = require('./lib/get-build-list.js');
const getNodeTargetsForOS = require('./lib/get-node-targets-for-os.js');
const runNodeBuild = require('./lib/run-node-build.js');

const debug = debuglog('noderegression');
const {
  mkdir,
  rmdir,
// https://github.com/mysticatea/eslint-plugin-node/issues/174
// eslint-disable-next-line node/no-unsupported-features/node-builtins
} = fs.promises;
const randomBytes = promisify(crypto.randomBytes);

const defaultOptions = {
  buildBaseUrl: 'https://nodejs.org/download/nightly/',
  env: process.env,
  stderr: process.stderr,
};
const minBuildDateMs = Date.UTC(2016, 0, 28);

/** Node.js build information.
 *
 * @typedef {!object} BuildInfo
 * @property {string} version Version string (vX.Y.Z-nightlyYYYYMMDDHASH).
 * @property {string} date Build date (YYYY-MM-DD).
 * @property {!Array<string>} files Build target name ($platform-$arch-$format).
 * @property {string} npm NPM version in build.
 * @property {string} v8 V8 version in build.
 * @property {string} uv libuv version in build.
 * @property {string} zlib zlib version in build.
 * @property {string} openssl OpenSSL version in build.
 * @property {string} modules Number of build-in modules? (as string)
 * @property {boolean} lts Build is for long-term support.
 * @property {boolean} security Build is for security support.
 */

/** noderegression Options
 *
 * @typedef {!object} NoderegressionOptions
 * @property {module:stream.Writable=} bisectLog Stream to which bisect
 * progress will be written, in the format produced by `git bisect log`.
 * @property {string=} buildCacheDir Directory below which Node.js builds are
 * saved (with the same path as added to {@link buildBaseUrl}). (default:
 * ${OS-specific user cache directory}/noderegression)
 * @property {string=} buildBaseUrl URL from which to download the build list
 * (as index.json) and referenced builds. (default:
 * https://nodejs.org/download/nightly/)
 * @property {object<string,string>=} env Environment variables. (default: =
 * process.env)
 * @property {string=} exeDir Directory to which the Node.js executable will be
 * extracted, then executed, for each build. (default: a temporary subdirectory
 * of os.tmpdir())
 * @property {module:node-fetch.RequestInit=} fetchOptions Options passed to
 * node-fetch when downloading Node.js builds or the build list JSON.
 * @property {Array<string>=} targets Build target names (matching
 * {@link BuildInfo.files}) on which to find a regression.  First match for
 * each build is used. (default: targets for current platform)
 * @property {!module:stream.Writable=} stderr Stream to which errors and
 * non-output status messages are written.  (default: process.stderr)
 * @property {number=} verbosity Amount of output to produce.  Higher numbers
 * produce more output.  Lower (i.e. more negative) numbers produce less.
 * (default: 0)
 */

function filterByDate(builds, after, before) {
  const afterStr =
    after ? after.toISOString().slice(0, 10) : '0000-00-00';
  const beforeStr =
    before ? before.toISOString().slice(0, 10) : '9999-99-99';

  return builds.filter(({ date }) => date < afterStr || date > beforeStr);
}

function getBuildTargetPairs(builds, targets) {
  // Surround needle and haystack with separator for easy string set search
  const commaTargets = targets.map((t) => `,${t},`);
  return builds
    .map((build) => {
      const commaFiles = `,${build.files},`;
      const matchInd = commaTargets.findIndex((ct) => commaFiles.includes(ct));
      if (matchInd < 0) {
        return undefined;
      }
      return [build, targets[matchInd]];
    })
    .filter(Boolean);
}

/** Ensure a given options object has fetchOptions.agent.
 *
 * @private
 * @param {!NoderegressionOptions} options Options object to modify.
 * @returns {!module:http.Agent|undefined} Agent, if one was created.
 */
function ensureAgent(options) {
  if (options.fetchOptions && options.fetchOptions.agent) {
    debug('Using caller-provided http.Agent.');
    return undefined;
  }

  const { protocol } = new URL(options.buildBaseUrl);
  const Agent = protocol === 'https:' ? HttpsAgent
    : protocol === 'http:' ? HttpAgent
      : undefined;
  if (!Agent) {
    debug('Unable to create keep-alive Agent for %s.', protocol);
    return undefined;
  }

  debug('Creating keep-alive http.Agent.');
  const agent = new Agent({ keepAlive: true });
  options.fetchOptions = {
    ...options.fetchOptions,
    agent,
  };
  return agent;
}

// FIXME: Duplicated with doc in lib/get-build-list.js
// Would like to use @borrows, but can't find a way to make it work.
// @borrows module:lib/get-build-list.getBuildList as getBuildList
/** Gets the list of builds which for commits to bisect, in commit order.
 *
 * @function
 * @param {string=} buildIndexUrl URL of JSON build list.
 * (default: https://nodejs.org/download/nightly/index.json)
 * @param {module:node-fetch.RequestInit=} options Fetch options.
 * @returns {!Array<!module:noderegression.BuildInfo>} Builds to bisect in
 * commit order.
 */
exports.getBuildList = getBuildList;

/** Performs regression range reduction, using bisection, on Node.js builds
 * within a given date range.
 *
 * @param {Date=} good Date of last known-good build, if any.
 * @param {Date=} bad Date of first known-bad build, if any.
 * @param {!Array<string>} testCmdWithArgs Command (with any arguments) to
 * run which tests whether a build is good.
 * @param {NoderegressionOptions=} options Options object.
 * @returns {!Array<!BuildInfo>} Pair (i.e. 2-element Array) of last-good and
 * first-bad builds in bisected range.
 */
exports.bisectRange =
async function bisectRange(good, bad, testCmdWithArgs, options) {
  if (!testCmdWithArgs
    || typeof testCmdWithArgs[Symbol.iterator] !== 'function') {
    throw new TypeError('testCmdWithArgs must be iterable');
  }
  if (options !== undefined && typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }

  options = {
    ...defaultOptions,
    ...options,
  };

  if (!options.buildBaseUrl.endsWith('/')) {
    options.buildBaseUrl += '/';
  }

  if (good && good.getTime() <= minBuildDateMs) {
    options.stderr.write(
      'Warning: Node.js 0.12 and 0.10 builds are not considered due to '
      + 'dates out of sequence and differing exe URLs.',
    );
  }

  // Keep the connection alive for downloading builds
  const agent = ensureAgent(options);
  try {
    const allBuilds = await getBuildList(
      `${options.buildBaseUrl}index.json`,
      options.fetchOptions,
    );
    const dateBuilds = filterByDate(allBuilds, good, bad);
    if (dateBuilds.length === 0) {
      throw new Error(
        `No builds after ${good.toUTCString()} before ${bad.toUTCString()}`,
      );
    }

    return await exports.bisectBuilds(dateBuilds, testCmdWithArgs, options);
  } finally {
    if (agent) {
      agent.destroy();
    }
  }
};

/** Performs regression range reduction, using bisection, on a given Array of
 * Node.js build.
 *
 * @param {!Array<!BuildInfo>} builds Builds to search for regression.
 * @param {!Array<string>} testCmdWithArgs Command (with any arguments) to
 * run which tests whether a build is good.
 * @param {NoderegressionOptions=} options Options object.
 * @returns {!Array<!BuildInfo>} Pair (i.e. 2-element Array) of last-good and
 * first-bad builds in bisected range.
 */
exports.bisectBuilds =
async function bisectBuilds(builds, [testCommand, ...testArgs], options) {
  if (!testCommand || typeof testCommand !== 'string') {
    throw new TypeError('testCommand must be a non-empty string');
  }
  if (options !== undefined && typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }

  options = {
    ...defaultOptions,
    ...options,
  };

  if (!options.buildBaseUrl.endsWith('/')) {
    options.buildBaseUrl += '/';
  }

  if (!options.buildCacheDir) {
    const cacheDir = options.env.XDG_CACHE_HOME
      || options.env.LOCALAPPDATA
      || (process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local')
        : path.join(os.homedir(), '.cache'));
    options.buildCacheDir = path.join(cacheDir, 'noderegression');
  }

  if (!options.targets) {
    options.targets = getNodeTargetsForOS(os);
  }

  const buildTargetPairs = getBuildTargetPairs(builds, options.targets);
  if (buildTargetPairs.length === 0) {
    throw new Error(`No builds in given range for ${options.targets.join()}`);
  }

  const rmExeDir = !options.exeDir;
  if (!options.exeDir) {
    const randomSuffixBytes = await randomBytes(6);
    // TODO [engine:node@>=15.7]: Use base64url
    const randomSuffix = randomSuffixBytes.toString('base64')
      // Filename-safe base64url variant from RFC 4648
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    // Note: /tmp might be mounted noexec
    // Can't check without statfs:
    // https://stackoverflow.com/a/15711534
    // https://github.com/nodejs/node/issues/10745
    // https://github.com/nodejs/node/pull/31351
    options.exeDir = path.join(os.tmpdir(), `noderegression-${randomSuffix}`);
    await mkdir(options.exeDir, { mode: 0o755 });
  }

  // Keep the connection alive for downloading multiple builds
  const agent = ensureAgent(options);

  let found;
  try {
    found = await binarySearchAsync(
      buildTargetPairs,
      async ([build, target]) => {
        const { code, signal } = await runNodeBuild(
          build.version,
          target,
          testCommand,
          testArgs,
          options,
        );
        if (signal) {
          throw new Error(`node killed with ${signal}`);
        }
        if (code < 0 || code >= 128) {
          throw new Error(`exit code ${code} is < 0 or >= 128`);
        }
        if (code === 125) {
          throw new Error('skip not yet implemented for exit code 125');
        }

        const goodbad = code === 0 ? 'good' : 'bad';
        if (options.verbosity >= 1) {
          options.stderr.write(`Build ${build.version} tested ${goodbad}\n`);
        }
        if (options.bisectLog) {
          // Output progress in format compatible with `git bisect log`
          options.bisectLog.write(
            `# ${goodbad}: ${build.version}\n`
            + `git bisect ${goodbad} ${build.commit}\n`,
          );
        }

        return code === 0 ? 1 : -1;
      },
      undefined,
      undefined,
      (low, high) => {
        if (options.verbosity >= 0) {
          const count = high - low + 1;
          const steps = Math.ceil(Math.log2(count)) + 1;
          options.stderr.write(
            `${count} builds left to test (~${steps} steps)\n`,
          );
        }
      },
    );
  } finally {
    if (agent) {
      agent.destroy();
    }

    if (rmExeDir) {
      try {
        await rmdir(options.exeDir, { recursive: true });
      } catch (errRm) {
        options.stderr.write(
          `Unable to remove temp dir ${options.exeDir}: ${errRm}\n`,
        );
      }
    }
  }

  const firstBadInd = -found - 1;
  const goodBuild = buildTargetPairs[firstBadInd - 1][0];
  const badBuild = buildTargetPairs[firstBadInd][0];
  return [goodBuild, badBuild];
};
