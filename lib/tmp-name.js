/**
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @private
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

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
export default async function tmpName(
  tmpDir = tmpdir(),
  prefix = 'noderegression-',
) {
  const randBytes = await randomBytesAsync(6);
  const randChars = randBytes.toString('base64url');
  return path.join(tmpDir, prefix + randChars);
}
