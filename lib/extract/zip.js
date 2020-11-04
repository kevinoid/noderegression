/**
 * Extract members from a zipfile file.
 *
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const yauzl = require('yauzl');

// https://github.com/mysticatea/eslint-plugin-node/issues/174
// eslint-disable-next-line node/no-unsupported-features/node-builtins
const { mkdir } = fs.promises;

module.exports =
function extractZip(zipPath, fileList, options) {
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
      zipfile.on('entry', (entry) => {
        const dest = fileList[entry.fileName];
        if (!dest) {
          zipfile.readEntry();
          return;
        }

        entryCount += 1;
        Promise.all([
          openReadStreamP.call(zipfile, entry),
          mkdir(path.dirname(dest), dirOptions),
        ])
          .then(([entryStream]) => pipeline(
            entryStream,
            fs.createWriteStream(dest, fileOptions),
            (errWrite) => {
              if (errWrite) {
                reject(errWrite);
              } else {
                zipfile.readEntry();
              }
            },
          ))
          .catch(reject);
      });
      zipfile.once('close', () => resolve(entryCount));
    });
  });
};
