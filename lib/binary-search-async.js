/**
 * Implementation of binary search with a Promise-returning comparator.
 *
 * Based on
 * https://github.com/rcfox/binary-search-promises/blob/2abe2df/src/index.js
 *
 * @copyright Copyright 2016 Ryan Fox
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

async function binarySearchImpl(haystack, compare, low, high, progress) {
  if (low > high) {
    return -low - 1;
  }

  progress(low, high);

  const mid = low + Math.floor((high - low) / 2);
  const compareResult = await compare(haystack[mid]);
  if (typeof compareResult !== 'number') {
    throw new TypeError(
      `compare result must be number, got ${typeof compareResult}`,
    );
  }

  if (compareResult > 0) {
    return binarySearchImpl(haystack, compare, mid + 1, high, progress);
  }

  if (compareResult < 0) {
    return binarySearchImpl(haystack, compare, low, mid - 1, progress);
  }

  if (Number.isNaN(compareResult)) {
    return compareResult;
  }

  return mid;
}

/**
 * Binary search `haystack` using a given Promise-returning `compare` function.
 *
 * @template T
 * @param {!Array<T>} haystack Sorted Array-like to be searched.
 * @param {function(T): Promise<number>} compare Comparison function which
 * resolves to a positive number if the desired value is greater than the
 * argument, a negative number if less, zero if found.
 * @param {number=} low Smallest index of `haystack` to search (inclusive).
 * @param {number=} high Largest index of `haystack` to search (inclusive).
 * @param {function(number, number)} progress Progress callback called whenever
 * low/high (inclusive) bounds change.
 * @returns {!Promise<number>} An index where `compare` returned 0, or the
 * two's complement of the smallest index where `compare` returned a positive
 * value (i.e. where insertion would preserve sorted order).
 */
module.exports =
function binarySearchAsync(haystack, compare, low, high, progress) {
  const { length } = haystack;

  if (low === undefined || low === null) {
    low = 0;
  } else if (typeof low !== 'number') {
    throw new TypeError(`low must be number, got ${typeof low}`);
  } else if (low < 0 || Math.floor(low) !== low) {
    throw new RangeError(`low must be a non-negative integer, got ${low}`);
  }

  if (high === undefined || high === null) {
    high = length - 1;
  } else if (typeof high !== 'number') {
    throw new TypeError(`high must be number, got ${typeof high}`);
  } else if (high < 0 || Math.floor(high) !== high) {
    throw new RangeError(`high must be a non-negative integer, got ${high}`);
  }

  if (low >= length) {
    return -length - 1;
  }

  if (high >= length) {
    high = length - 1;
  }

  return binarySearchImpl(
    haystack,
    compare,
    low,
    high,
    progress,
  );
};
