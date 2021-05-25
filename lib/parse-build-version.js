/**
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

export default function parseBuildVersion(version) {
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
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    year: Number(year),
    month: Number(month),
    day: Number(day),
    commit,
  };
}
