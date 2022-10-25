/**
 * Functions for getting build information from nodejs.org.
 *
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @private
 */

// TODO [engine:node@>=17.5]: Use native fetch
import nodeFetch from 'node-fetch';
import { debuglog } from 'node:util';

import HttpResponseError from './http-response-error.js';
import splitBuildVersion from './split-build-version.js';
import { addDashes } from './ymd-utils.js';

const debug = debuglog('noderegression:get-build-list');

/** Commits which are not present in https://github.com/nodejs/node
 * Note: Can check using `git rev-parse --verify --quiet "$commit"`.
 *
 * @private
 */
const missingCommits = new Set([
  '60f2fa9a8b',
  '9cae65c510',
  'a4ed3ea214',
]);

/** Commits for builds with .0.0 version, which are not ancestors of master.
 * Note: Can check using `git merge-base --is-ancestor $commit master`.
 *
 * @private
 */
const nonMasterCommits = new Set([
  '2296a4fc0f',
  '3518372835',
  '60042ca70e',
  '6a04cc0a43',
  '6bbdd668bd',
  '6e78382605',
  '6eece7773e',
  'bf7c3dabb4',
  'd62e7bd1f9',
  'e6d1d54230',
]);

/** Commit order for builds which occurred on the same date.
 * Note: Can check using `git merge-base --is-ancestor $commit1 $commit2`.
 *
 * @private
 */
const commitOrderByDate = {
  20180129: ['5c8ce90c2f', '4a498335f5'],
  20161013: ['e4ee09a5b3', '804d57db67'],
  20161008: ['b35f22b135', '7084b9c5a1'],
  20160712: ['ef1f7661c7', '863952ebad'],
  20160415: ['81fd4581b9', '4a74fc9776'],
  20160307: ['449684752c', '061ebb39c9'],
  20160116: ['66b9c0d8bd', 'da550aa063'],
};

/** Filter build list to include only commits useful for bisecting and
 * normalize the information in those builds.
 *
 * @private
 * @param {!Array<!module:noderegression.BuildInfo>} builds Array of builds.
 * @returns {!Array<!module:noderegression.BuildInfo>} Builds for unique
 * commits which are ancestors of the master branch.
 */
function filterAndNormalizeBuilds(builds) {
  const commitToVersion = new Map();
  return builds.filter((build) => {
    if (build.version.startsWith('v0.')) {
      // Skip 0.12/0.10, which have dates after v5.5.1 and exe files
      // with different paths than the others.
      debug(`Ignoring build ${build.version} for pre-4.0 commit.`);
      return false;
    }

    const [version, , commit] = splitBuildVersion(build.version);

    // Commits which are not ancestors of master are not helpful for bisecting
    // a regression on master.
    if (!version.endsWith('.0.0') || nonMasterCommits.has(commit)) {
      debug(`Ignoring build ${build.version} for non-master commit.`);
      return false;
    }

    // Some commits no longer exist in the git repository (post-build rebase?)
    // Not helpful for bisecting.
    if (missingCommits.has(commit)) {
      debug(
        `Ignoring build ${build.version} with commit ${commit} not in git.`,
      );
      return false;
    }

    // Some commits are built on multiple days (c8df5cf74a on 20191017 and 18)
    const commitVer = commitToVersion.get(commit);
    if (commitVer) {
      debug(
        `Ignoring build ${build.version} with same commit as ${commitVer}.`,
      );
      return false;
    }
    commitToVersion.set(commit, build.version);

    return true;
  });
}

/** Reorder builds in a given range to match a given commit order.
 *
 * @private
 * @param {!Array<!module:noderegression.BuildInfo>} builds Array of builds to
 * reorder.
 * @param {number} start Smallest index of range to reorder.
 * @param {number} end Index after largest index of range to reorder.
 * @param {!Array<!string>} commitOrder Commits in desired order.
 */
function reorderRange(builds, start, end, commitOrder) {
  for (const build of builds.slice(start, end)) {
    const [,, commit] = splitBuildVersion(build.version);
    const pos = commitOrder.indexOf(commit);
    if (pos < 0) {
      throw new Error(
        `commit ${commit} not found in ordering for ${build.date}`,
      );
    }

    builds[start + pos] = build;
  }
}

/** Reorder builds to match commit order.
 *
 * @private
 * @param {!Array<!module:noderegression.BuildInfo>} builds Array of builds to
 * reorder.
 * @param {!GetBuildListOptions=} options Options.
 */
function reorderBuilds(builds, options = {}) {
  if (builds.length === 0) {
    return;
  }

  let prevVersion = builds[0].version;
  let [, prevYMD] = splitBuildVersion(prevVersion);
  for (let i = 1; i < builds.length; i += 1) {
    const { version } = builds[i];
    const [, ymd] = splitBuildVersion(version);
    if (ymd > prevYMD) {
      throw new Error(
        `Expected builds in decreasing order by date: ${version} after ${
          prevVersion}`,
      );
    }

    if (ymd === prevYMD) {
      const commitOrder = commitOrderByDate[ymd];
      if (commitOrder) {
        let lastSame = i + 1;
        while (lastSame < builds.length
          && splitBuildVersion(builds[lastSame].version)[1] === ymd) {
          lastSame += 1;
        }

        if (commitOrder.length !== lastSame - i + 1) {
          throw new Error(
            `expected ${commitOrder.length} builds on ${addDashes(ymd)}, got ${
              lastSame - i + 1}`,
          );
        }

        reorderRange(builds, i - 1, lastSame, commitOrder);
        i = lastSame - 1;
      } else {
        // Builds with same date in version and no known ordering.
        // To fix this, add git commit order to commitOrderByDate.
        const message = `Build ${prevVersion} and ${version}`
          + ' have the same date with no known ordering.';
        if (options.strictOrder) {
          throw new Error(message);
        } else {
          debug(message);
        }
      }
    }

    prevVersion = version;
    prevYMD = ymd;
  }

  builds.reverse();
}

/** Options for {@link getBuildList}.
 *
 * @typedef {!object} GetBuildListOptions
 * @property {!module:node-fetch.fetch=} fetch Fetch function compatible with
 * node-fetch for downloading the build list.
 * @property {!module:node-fetch.RequestInit=} fetchOptions Options passed to
 * {@link fetch} when downloading the build list.
 * @property {boolean=} strictOrder Throw an exception if build order is not
 * known correct (e.g. builds on same date with unknown order)
 */

/** Gets the list of builds which for commits to bisect, in commit order.
 *
 * @param {string=} buildIndexUrl URL of JSON build list.
 * (default: https://nodejs.org/download/nightly/index.json)
 * @param {!GetBuildListOptions=} options Options.
 * @returns {!Array<!module:noderegression.BuildInfo>} Builds to bisect in
 * commit order.
 */
export default async function getBuildList(
  buildIndexUrl = 'https://nodejs.org/download/nightly/index.json',
  options = {},
) {
  const {
    fetch = nodeFetch,
    fetchOptions,
  } = options;
  const res = await fetch(buildIndexUrl, fetchOptions);
  if (!res.ok) {
    throw new HttpResponseError(res);
  }

  try {
    const allBuilds = await res.json();
    const builds = filterAndNormalizeBuilds(allBuilds);
    reorderBuilds(builds, options);
    return builds;
  } catch (err) {
    err.message = `Error processing ${buildIndexUrl}: ${err.message}`;
    throw err;
  }
}
