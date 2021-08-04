/**
 * @copyright Copyright 2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @private
 */

/** Adds dashes to convert a string in YYYYMMDD format to YYYY-MM-DD.
 *
 * @param {string} ymd String in YYYYMMDD format.
 * @returns {string} String in YYYY-MM-DD format.
 * @throws {TypeError} If ymd is not a string.
 * @throws {RangeError} If ymd is not 8 characters long.
 */
// eslint-disable-next-line import/prefer-default-export
export function addDashes(ymd) {
  if (typeof ymd !== 'string') {
    throw new TypeError(`ymd must be string, got ${typeof ymd}`);
  }

  if (ymd.length !== 8) {
    throw new RangeError(`ymd must have 8 characters, got ${ymd.length}`);
  }

  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}
