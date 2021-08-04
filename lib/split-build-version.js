/**
 * @copyright Copyright 2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @private
 */

/** Splits a build version string into version, date, and commit parts.
 *
 * @param {string} version Build version string.
 * @returns {!Array<string>} 3-tuple with version (as "vX.Y.Z" where X, Y, and
 * Z are numbers), date (as "YYYYMMDD"), and commit (as lower-case hex digits).
 * @throws {RangeError} If version does not have the expected format.
 */
export default function splitBuildVersion(version) {
  const match =
    /^(v[0-9]+\.[0-9]+\.[0-9]+)-nightly(20[0-9][0-9][01][0-9][0-3][0-9])([0-9a-f]+)$/
      .exec(version);
  if (!match) {
    throw new RangeError(
      `Build version "${version}" does not have expected format`,
    );
  }

  return match.slice(1);
}
