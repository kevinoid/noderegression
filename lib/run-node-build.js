/**
 * Functions for downloading and running a Node.js build.
 *
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @private
 */

import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  stat,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import HttpResponseError from './http-response-error.js';

function getBuildArchiveBasename(version, target) {
  const [osname, arch] = target.split('-');
  const uname = osname === 'osx' ? 'darwin' : osname;
  return `node-${version}-${uname}-${arch}`;
}

function getBuildUrlPath(version, target) {
  const [, arch, format] = target.split('-');

  if (format === 'exe') {
    return `win-${arch}/node.exe`;
  }

  const basename = getBuildArchiveBasename(version, target);
  const ext = format === undefined || format === 'tar' ? 'tar.gz' : format;
  return `${version}/${basename}.${ext}`;
}

function downloadFile(filePath, fileUrl, options) {
  const myFetch = options.fetch ?? fetch;
  return myFetch(fileUrl, options.fetchOptions)
    .then(async (res) => {
      if (!res.ok) {
        throw new HttpResponseError(res);
      }

      const fileDir = path.dirname(filePath);
      // Note: created directory only returned by Node.js v12.17/v13.11
      // TODO: Polyfill for old versions.
      const createdDir = await mkdir(fileDir, { recursive: true });

      const partPath = `${filePath}.part`;
      try {
        await pipeline(
          res.body,
          createWriteStream(partPath),
        );

        await rename(partPath, filePath);
      } catch (errPipe) {
        // Remove partially downloaded file, if it was created
        try {
          await unlink(partPath);
        } catch (errUnlink) {
          if (errUnlink.code !== 'ENOENT') {
            options.console.error('Error removing %s: %o', partPath, errUnlink);
          }
        }

        // Remove created directories, if empty
        if (createdDir) {
          try {
            let removeDir = fileDir;
            while (removeDir.length >= createdDir.length) {
              // eslint-disable-next-line no-await-in-loop
              await rmdir(removeDir);
              removeDir = path.dirname(removeDir);
            }
          } catch (errRmdir) {
            if (errRmdir.code !== 'ENOTEMPTY') {
              options.console.error('Error removing %s: %o', fileDir, errRmdir);
            }
          }
        }

        throw errPipe;
      }
    });
}

async function ensureFile(filePath, fileUrl, options) {
  try {
    await stat(filePath);

    // If stat didn't throw, the file exists
    return;
  } catch (errStat) {
    if (errStat.code !== 'ENOENT') {
      throw errStat;
    }
  }

  await downloadFile(filePath, fileUrl, options);
}

async function getExtractorForBuild(version, target) {
  const format = target.split('-')[2];
  let extractMod;
  switch (format) {
    case 'exe':
      return undefined;
    case undefined:
    case 'tar':
      extractMod = await import('./extract/tar.js');
      break;
    case 'zip':
      extractMod = await import('./extract/zip.js');
      break;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  return extractMod.default;
}

function getMemberForBuild(version, target) {
  const buildBasename = getBuildArchiveBasename(version, target);
  const binExt = version.startsWith('win') ? '.exe' : '';
  return `${buildBasename}/bin/node${binExt}`;
}

function makeEnvWithPath(env, newPathDir) {
  const newEnv = Object.create(null);
  if (!env) {
    newEnv.PATH = newPathDir;
    return newEnv;
  }

  Object.assign(newEnv, env);
  let envPath = newEnv.PATH;

  // Windows environment is case-insensitive (but case-preserving).
  // Last value of any capitalization is the one seen by the child process.
  // To avoid confusion, remove all but "PATH".
  if (process.platform === 'win32') {
    // eslint-disable-next-line no-restricted-syntax
    for (const name in newEnv) {
      if (/^path$/i.test(name)) {
        envPath = newEnv[name];

        if (name !== 'PATH') {
          delete newEnv[name];
        }
      }
    }
  }

  newEnv.PATH =
    envPath ? `${newPathDir}${path.delimiter}${envPath}` : newPathDir;
  return newEnv;
}

/**
 * @typedef {!object} SpawnResult
 * @property {number} code Exit code of child process.
 * @property {string=} signal Name of signal which killed child process.
 */

/** Promisified version of child_process.spawn().
 *
 * @private
 * @param {string} command Command to spawn.
 * @param {Array<string>=} args Arguments passed to command.
 * @param {module:child_process.SpawnOptions=} options Spawn options.
 * @returns {!module:child_process.PromiseWithChild<SpawnResult>} Promise
 * for execution result with ChildProcess as .child property.
 */
function spawnP(command, args, options) {
  let resolve, reject;
  // eslint-disable-next-line promise/param-names
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  promise.child = spawn(command, args, options)
    .once('error', reject)
    .once('close', (code, signal) => resolve({ code, signal }));

  return promise;
}

/** Execute a given command with Node.js from a given build in $PATH.
 *
 * @private
 * @param {string} version Build version to run
 * (from {@link module:noderegression.BuildInfo.version}).
 * @param {string} target Build target to run
 * (from {@link module:noderegression.BuildInfo.files}).
 * @param {string} command Command to run.
 * @param {Array<string>=} args Arguments passed to command.
 * @param {!module:noderegression.NoderegressionOptions} options Options.
 * @returns {!module:child_process.PromiseWithChild<SpawnResult>} Promise
 * for execution result with ChildProcess as .child property.
 */
export default async function runNodeBuild(
  version,
  target,
  command,
  args,
  options,
) {
  const buildUrlPath = getBuildUrlPath(version, target);
  const buildUrl = options.buildBaseUrl + buildUrlPath;
  const cachePath = path.join(
    options.buildCacheDir,
    buildUrlPath.replaceAll('/', path.sep),
  );
  // Note: Get extractor before downloading to avoid wasting bandwidth on error
  const extract = await getExtractorForBuild(version, target);
  await ensureFile(cachePath, buildUrl, options);

  const nodeExe = path.join(
    options.exeDir,
    target.startsWith('win') ? 'node.exe' : 'node',
  );
  if (extract) {
    const memberPath = getMemberForBuild(version, target);
    const entryCount = await extract(cachePath, {
      [memberPath]: nodeExe,
    });
    if (entryCount !== 1) {
      throw new Error(`${memberPath} not found in ${cachePath}`);
    }
  } else {
    await copyFile(
      cachePath,
      nodeExe,
      constants.COPYFILE_FICLONE,
    );
  }

  return spawnP(
    command,
    args,
    {
      env: makeEnvWithPath(options.env, options.exeDir),
      stdio: 'inherit',
    },
  );
}
