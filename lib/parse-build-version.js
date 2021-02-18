/**
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

module.exports =
function parseBuildVersion(version) {
  const match =
    /^v([0-9]+)\.([0-9]+)\.([0-9]+)-nightly(20[0-9][0-9])([01][0-9])([0-3][0-9])([0-9a-f]+)$/
      .exec(version);
  if (!match) {
    throw new Error(
      `Build version "${version}" does not have expected format`,
    );
  }

  const [, major, minor, patch, year, month, day, commit] = match;
  return {
    major,
    minor,
    patch,
    year,
    month,
    day,
    commit,
  };
};
