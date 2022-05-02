/**
 * @copyright Copyright 2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

import assert from 'assert';
import { readFile } from 'fs/promises';

import { bisectRange, bisectBuilds, getBuildList } from '../index.js';
import getBuildListPrivate from '../lib/get-build-list.js';

let testBuilds;
before(async () => {
  const buildIndexUrl =
    new URL('../test-data/build-index.json', import.meta.url);
  const content = await readFile(buildIndexUrl, { encoding: 'utf8' });
  const buildIndex = JSON.parse(content);
  testBuilds = buildIndex.slice(0, 1);
});

describe('bisectBuilds', () => {
  it('rejects if builds is undefined', () => {
    assert.rejects(
      () => bisectBuilds(undefined, ['cmd']),
      TypeError,
    );
  });

  it('rejects if builds is not iterable', () => {
    assert.rejects(
      () => bisectBuilds({}, ['cmd']),
      TypeError,
    );
  });

  it('rejects if builds is empty', () => {
    assert.rejects(
      () => bisectBuilds([], ['cmd']),
      Error,
    );
  });

  it('rejects if testCmd is undefined', () => {
    assert.rejects(
      () => bisectBuilds(testBuilds),
      TypeError,
    );
  });

  it('rejects if testCmd is not iterable', () => {
    assert.rejects(
      () => bisectBuilds(testBuilds, {}),
      TypeError,
    );
  });

  // Note: Could wrap string to Array, but may confuse callers that expect
  // the string to be shell interpreted (i.e. split on white space).
  it('rejects if testCmd is a string', () => {
    assert.rejects(
      () => bisectBuilds(testBuilds, 'test'),
      TypeError,
    );
  });

  it('rejects if options is not an object', () => {
    assert.rejects(
      () => bisectBuilds(testBuilds, ['cmd'], 'test'),
      TypeError,
    );
  });
});

describe('bisectRange', () => {
  it('rejects if good is not a Date', () => {
    assert.rejects(
      () => bisectRange('invalid'),
      TypeError,
    );
  });

  it('rejects if good is not at midnight UTC', () => {
    assert.rejects(
      () => bisectRange(new Date(2020, 0, 1, 12)),
      RangeError,
    );
  });

  it('rejects if bad is not a Date', () => {
    assert.rejects(
      () => bisectRange(undefined, 'invalid'),
      TypeError,
    );
  });

  it('rejects if bad is not at midnight UTC', () => {
    assert.rejects(
      () => bisectRange(undefined, new Date(2020, 0, 1, 12)),
      RangeError,
    );
  });

  it('rejects if bad is before good', () => {
    assert.rejects(
      () => bisectRange(new Date(2020, 0, 2), new Date(2020, 0, 1)),
      RangeError,
    );
  });

  it('rejects if testCmd is undefined', () => {
    assert.rejects(
      () => bisectRange(),
      TypeError,
    );
  });

  it('rejects if testCmd is not iterable', () => {
    assert.rejects(
      () => bisectRange(undefined, undefined, {}),
      TypeError,
    );
  });

  // Note: Could wrap string to Array, but may confuse callers that expect
  // the string to be shell interpreted (i.e. split on white space).
  it('rejects if testCmd is a string', () => {
    assert.rejects(
      () => bisectRange(undefined, undefined, 'test'),
      TypeError,
    );
  });

  it('rejects if options is not an object', () => {
    assert.rejects(
      () => bisectRange(undefined, undefined, ['cmd'], 'test'),
      TypeError,
    );
  });
});

describe('getBuildList', () => {
  // Tests are in test/get-build-list.js
  it('is exported from ./lib/get-build-list.js', () => {
    assert.strictEqual(getBuildList, getBuildListPrivate);
  });
});
