/**
 * Functions for downloading and running a Node.js build.
 *
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const fetch = require('node-fetch');
const path = require('path');
const stream = require('stream');
const { promisify } = require('util');

const {
  copyFile,
  mkdir,
  stat,
  rename,
  rmdir,
  unlink,
// https://github.com/mysticatea/eslint-plugin-node/issues/174
// eslint-disable-next-line node/no-unsupported-features/node-builtins
} = fs.promises;

// TODO [engine:node@>=15]: Use pipeline from 'streams/promise'
const pipeline = promisify(stream.pipeline);

function getBuildArchiveBasename(build) {
  const { file, version } = build;
  const [osname, arch] = file.split('-');
  const uname = osname === 'osx' ? 'darwin' : osname;
  return `node-${version}-${uname}-${arch}`;
}

function getBuildUrlPath(build) {
  const { file, version } = build;
  const [, arch, format] = file.split('-');

  if (format === 'exe') {
    return `win-${arch}/node.exe`;
  }

  const basename = getBuildArchiveBasename(build);
  const ext = format === undefined || format === 'tar' ? 'tar.gz' : format;
  return `${version}/${basename}.${ext}`;
}

function downloadFile(filePath, fileUrl, options) {
  if (options.verbosity >= 0) {
    options.stderr.write(`Downloading ${fileUrl} to ${filePath}...\n`);
  }

  return fetch(fileUrl, options)
    .then(async (res) => {
      if (!res.ok) {
        // FIXME: Should anything be done to discard the response?
        // Could call #destroy(). (Would it propagate back the pipeline?
        // Would we need to handle 'error event?)
        // Could signal abort using abort-controller.
        throw new Error(
          `Error fetching ${fileUrl}: `
          + `HTTP Status ${res.status} ${res.statusText}`,
        );
      }

      const fileDir = path.dirname(filePath);
      await mkdir(fileDir, { recursive: true });

      const partPath = `${filePath}.part`;
      try {
        await pipeline(
          res.body,
          fs.createWriteStream(partPath),
        );

        await rename(partPath, filePath);
      } catch (errPipe) {
        // Remove partially downloaded file, if it was created
        try {
          await unlink(partPath);
        } catch (errUnlink) {
          if (errUnlink.code !== 'ENOENT') {
            options.stderr.write(`Error removing ${partPath}: ${errUnlink}\n`);
          }
        }

        // Remove directory, if empty
        try {
          await rmdir(fileDir);
        } catch (errRmdir) {
          if (errRmdir.code !== 'ENOTEMPTY') {
            options.stderr.write(`Error removing ${fileDir}: ${errRmdir}\n`);
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

function getExtractorForBuild(build) {
  const format = build.file.split('-')[2];
  switch (format) {
    case 'exe':
      return undefined;
    case undefined:
    case 'tar':
      // eslint-disable-next-line global-require
      return require('./extract/tar.js');
    case 'zip':
      // eslint-disable-next-line global-require
      return require('./extract/zip.js');
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

function getMemberForBuild(build) {
  const buildBasename = getBuildArchiveBasename(build);
  const binExt = build.file.startsWith('win') ? '.exe' : '';
  return `${buildBasename}/bin/node${binExt}`;
}

function spawnP(command, args, options) {
  return new Promise((resolve, reject) => {
    spawn(command, args, options)
      .once('error', reject)
      .once('close', (code, signal) => resolve({ code, signal }));
  });
}

module.exports =
async function runNodeBuild(build, nodeArgs, options) {
  const buildUrlPath = getBuildUrlPath(build);
  const buildUrl = options.buildBaseUrl + buildUrlPath;
  const cachePath = path.join(
    options.buildCacheDir,
    buildUrlPath.replace(/\//g, path.sep),
  );
  // Note: Get extractor before downloading to avoid wasting bandwidth on error
  const extract = getExtractorForBuild(build);
  await ensureFile(cachePath, buildUrl, options);

  const nodeExe = path.join(
    options.exeDir,
    build.file.startsWith('win') ? 'node.exe' : 'node',
  );
  if (extract) {
    const memberPath = getMemberForBuild(build);
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
      fs.constants.COPYFILE_FICLONE,
    );
  }

  return spawnP(
    nodeExe,
    nodeArgs,
    { stdio: 'inherit' },
  );
};
