/**
 * Use binary search to find Node.js build which introduced a bug.
 * Node.js analog to mozregression.
 *
 * @copyright Copyright 2016-2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Agent: HttpAgent } = require('http');
const { Agent: HttpsAgent } = require('https');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const binarySearchAsync = require('./lib/binary-search-async.js');
const getBuildList = require('./lib/get-build-list.js');
const getNodeTargetsForOS = require('./lib/get-node-targets-for-os.js');
const runNodeBuild = require('./lib/run-node-build.js');

const {
  mkdir,
  rmdir,
// https://github.com/mysticatea/eslint-plugin-node/issues/174
// eslint-disable-next-line node/no-unsupported-features/node-builtins
} = fs.promises;
const randomBytes = promisify(crypto.randomBytes);

const minBuildDateMs = Date.UTC(2016, 0, 28);

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

exports.bisectRange =
async function bisectRange(good, bad, [testCommand, ...testArgs], options) {
  if (!testCommand || typeof testCommand !== 'string') {
    throw new TypeError('testCommand must be a non-empty string');
  }
  if (options !== undefined && typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }

  options = {
    buildBaseUrl: 'https://nodejs.org/download/nightly/',
    ...options,
  };

  if (!options.buildBaseUrl.endsWith('/')) {
    options.buildBaseUrl += '/';
  }

  if (!options.buildCacheDir) {
    const cacheDir = process.env.XDG_CACHE_HOME
      || process.env.LOCALAPPDATA
      || (process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local')
        : path.join(os.homedir(), '.cache'));
    options.buildCacheDir = path.join(cacheDir, 'noderegression');
  }

  if (!options.targets) {
    options.targets = getNodeTargetsForOS(os);
  }

  if (good && good.getTime() <= minBuildDateMs) {
    options.stderr.write(
      'Warning: Node.js 0.12 and 0.10 builds are not considered due to '
      + 'dates out of sequence and differing exe URLs.',
    );
  }

  // Keep the connection alive for downloading builds
  let agent;
  if (!options.fetchOptions || !options.fetchOptions.agent) {
    const { protocol } = new URL(options.buildBaseUrl);
    const Agent = protocol === 'https:' ? HttpsAgent
      : protocol === 'http:' ? HttpAgent
        : undefined;
    if (Agent) {
      agent = new Agent({ keepAlive: true });
      options.fetchOptions = {
        ...options.fetchOptions,
        agent,
      };
    }
  }

  const allBuilds = await getBuildList(options.fetchOptions);
  const dateBuilds = filterByDate(allBuilds, good, bad);
  if (dateBuilds.length === 0) {
    throw new Error(
      `No builds after ${options.good.toUTCString()} before ${
        bad.toUTCString()}`,
    );
  }

  const buildTargetPairs = getBuildTargetPairs(dateBuilds, options.targets);
  if (buildTargetPairs.length === 0) {
    throw new Error(
      `No builds after ${options.good.toUTCString()} before ${
        bad.toUTCString()} for ${options.targets.join()}`,
    );
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
