/**
 * Extract members from a tar file.
 *
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @private
 */

import { AssertionError } from 'assert';
import fs from 'fs';
import { Parse } from 'tar';
import path from 'path';
import stream from 'stream';
import { debuglog, promisify } from 'util';

const debug = debuglog('noderegression:extract/tar');
// TODO [engine:node@>=15]: Use pipeline from 'streams/promise'
const pipeline = promisify(stream.pipeline);

// Imported dynamically to extract tar filetype
// eslint-disable-next-line import/no-unused-modules
export default async function extractTar(tarPathOrStream, fileList, options) {
  const dirOptions = {
    mode: options && options.dirMode,
    recursive: true,
  };

  const tarParse = new Parse({
    strict: true,
    filter: (entryPath, entry) => {
      if (!fileList[entryPath]) {
        debug(`Not extracting ${entryPath}.`);
        return false;
      }
      return true;
    },
  });
  let entryCount = 0;
  tarParse.on('entry', (entry) => {
    const dest = fileList[entry.path];
    if (!dest) {
      tarParse.abort(new AssertionError({
        message: `entry with path ${entry.path} not filtered out!?`,
        operator: 'fail',
      }));
      return;
    }

    if (entry.type !== 'File') {
      tarParse.abort(new AssertionError({
        message: `unsupported entry type ${entry.type}`,
        operator: 'fail',
      }));
      return;
    }

    fs.mkdir(path.dirname(dest), dirOptions, (errDir) => {
      if (errDir) {
        tarParse.abort(errDir);
        return;
      }

      debug(`Extracting ${entry.path} to ${dest}...`);
      entryCount += 1;

      const fileOptions = {
        flags: options && options.fileFlags,
        mode: (options && options.fileMode) || entry.mode,
      };
      pipeline(
        entry,
        fs.createWriteStream(dest, fileOptions),
      )
        .catch((errPipe) => tarParse.abort(errPipe));
    });
  });

  const tarStream = typeof tarPathOrStream !== 'string' ? tarPathOrStream
    : fs.createReadStream(tarPathOrStream);
  await pipeline(
    tarStream,
    tarParse,
  );

  return entryCount;
}
