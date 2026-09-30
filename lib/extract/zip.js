/**
 * Extract members from a zipfile file.
 *
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';

import yauzl from 'yauzl';

const { mkdir } = fs.promises;

// Imported dynamically to extract zip filetype
export default function extractZip(zipPath, fileList, options) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(err);
        return;
      }

      const openReadStreamP = promisify(zipfile.openReadStream);
      const dirOptions = {
        mode: options && options.dirMode,
        recursive: true,
      };
      const fileOptions = {
        flags: options && options.fileFlags,
        mode: options && options.fileMode,
      };

      zipfile.once('error', reject);
      let entryCount = 0;
      zipfile.on('entry', async (entry) => {
        const dest = fileList[entry.fileName];
        if (!dest) {
          zipfile.readEntry();
          return;
        }

        entryCount += 1;
        try {
          const [entryStream] = await Promise.all([
            openReadStreamP.call(zipfile, entry),
            mkdir(path.dirname(dest), dirOptions),
          ]);
          await pipeline(
            entryStream,
            fs.createWriteStream(dest, fileOptions),
            (errWrite) => {
              if (errWrite) {
                reject(errWrite);
              } else {
                zipfile.readEntry();
              }
            },
          );
        } catch (errUnzip) {
          reject(errUnzip);
        }
      });
      zipfile.once('close', () => resolve(entryCount));
    });
  });
}
