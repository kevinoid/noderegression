/**
 * Functions for getting build information from nodejs.org.
 *
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

import nodeFetch from 'node-fetch';
import { debuglog } from 'util';

import parseBuildVersion from './parse-build-version.js';

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
  '2018-01-29': ['5c8ce90c2f', '4a498335f5'],
  '2016-10-13': ['e4ee09a5b3', '804d57db67'],
  '2016-10-08': ['b35f22b135', '7084b9c5a1'],
  '2016-07-12': ['ef1f7661c7', '863952ebad'],
  '2016-04-15': ['81fd4581b9', '4a74fc9776'],
  '2016-03-07': ['449684752c', '061ebb39c9'],
  '2016-01-16': ['66b9c0d8bd', 'da550aa063'],
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

    const { minor, patch, commit } = parseBuildVersion(build.version);

    // Commits which are not ancestors of master are not helpful for bisecting
    // a regression on master.
    if (minor !== 0 || patch !== 0 || nonMasterCommits.has(commit)) {
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
    const { commit } = parseBuildVersion(build.version);
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
 */
function reorderBuilds(builds) {
  for (let i = 1; i < builds.length; i += 1) {
    const build = builds[i];
    const prevBuild = builds[i - 1];
    if (build.date > prevBuild.date) {
      throw new Error(
        `Expected builds in decreasing order by date: ${build.version} after ${
          prevBuild.version}`,
      );
    }

    if (build.date === prevBuild.date) {
      const commitOrder = commitOrderByDate[build.date];
      if (!commitOrder) {
        // If this error occurs, add git commit order to commitOrderByDate.
        throw new Error(
          `Build ${prevBuild.version} and ${build.version} have the same `
          + 'date with no known ordering.',
        );
      }

      let lastSame = i + 1;
      while (lastSame < builds.length
        && builds[lastSame].date === build.date) {
        lastSame += 1;
      }

      if (commitOrder.length !== lastSame - i + 1) {
        throw new Error(
          `expected ${commitOrder.length} builds on ${build.date}, got ${
            lastSame - i + 1}`,
        );
      }

      reorderRange(builds, i - 1, lastSame, commitOrder);
      i = lastSame - 1;
    }
  }

  builds.reverse();
}

/** Gets the list of builds which for commits to bisect, in commit order.
 *
 * @param {string=} buildIndexUrl URL of JSON build list.
 * (default: https://nodejs.org/download/nightly/index.json)
 * @param {module:node-fetch.RequestInit=} options Fetch options.
 * @param {module:node-fetch.fetch=} fetch Fetch function.
 * @returns {!Array<!module:noderegression.BuildInfo>} Builds to bisect in
 * commit order.
 */
export default async function getBuildList(
  buildIndexUrl = 'https://nodejs.org/download/nightly/index.json',
  options,
  fetch = nodeFetch,
) {
  const res = await fetch(buildIndexUrl, options);
  if (!res.ok) {
    // FIXME: Should anything be done to discard the response?
    // Could call #destroy(). (Would it propagate back the pipeline?
    // Would we need to handle 'error event?)
    // Could signal abort using abort-controller.
    throw new Error(
      `Error fetching ${buildIndexUrl}: `
      + `HTTP Status ${res.status} ${res.statusText}`,
    );
  }

  try {
    const allBuilds = await res.json();
    const builds = filterAndNormalizeBuilds(allBuilds);
    reorderBuilds(builds);
    return builds;
  } catch (err) {
    err.message = `Error processing ${buildIndexUrl}: ${err.message}`;
    throw err;
  }
}
