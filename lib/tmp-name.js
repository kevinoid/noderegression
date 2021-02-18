/**
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const { randomBytes } = require('crypto');
const path = require('path');
const { tmpdir } = require('os');
const { promisify } = require('util');

const randomBytesAsync = promisify(randomBytes);

/** Gets a randomized path suitable for a temporary file or directory.
 * Does not check if the path exists.  Probabilistically it does not.
 *
 * @private
 * @param {string=} tmpDir Directory in which to generate the path.  (default:
 * os.tmpdir())
 * @param {string=} prefix Prefix added to last component of generated path.
 * (default: noderegression-)
 * @returns {string} A path from tmpDir + prefix + random characters.
 */
module.exports =
async function tmpName(
  tmpDir = tmpdir(),
  prefix = 'noderegression-',
) {
  const randBytes = await randomBytesAsync(6);
  // TODO [engine:node@>=15.7]: Use base64url
  const randChars = randBytes.toString('base64')
    // Filename-safe base64url variant from RFC 4648
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return path.join(tmpDir, prefix + randChars);
};
