/**
 * @copyright Copyright 2016,2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

import assert from 'node:assert';
import { readFile, unlink } from 'node:fs/promises';
import sinon from 'sinon';
import stream from 'node:stream';
import timers from 'node:timers';
import { promisify } from 'node:util';

import noderegressionMain from '../cli.js';
import tmpName from '../lib/tmp-name.js';

const { match } = sinon;
// TODO [engine:node@>=15]: import { setImmediate } from 'timers/promises';
const setImmediateP = promisify(timers.setImmediate);
// TODO [engine:node@>=15]: import { setTimeout } from 'timers/promises';
const setTimeoutP = promisify(timers.setTimeout);

// Simulate arguments passed by the node runtime
const testRuntimeArgs = ['node', 'noderegression'];
// Good/Bad build pair for testing
let testGoodBad;
const testGoodBadOut = 'Last good build: 8353854ed7 on 2021-02-17\n'
  + 'First bad build: 9a2ac2c615 on 2021-02-18\n';

let buildIndex;
before(async () => {
  const buildIndexUrl =
    new URL('../test-data/build-index.json', import.meta.url);
  const content = await readFile(buildIndexUrl, { encoding: 'utf8' });
  buildIndex = JSON.parse(content);
  testGoodBad = [buildIndex[1], buildIndex[0]];
});

let packageJson;
before(async () => {
  const packageJsonUrl = new URL('../package.json', import.meta.url);
  const content = await readFile(packageJsonUrl, { encoding: 'utf8' });
  packageJson = JSON.parse(content);
});

function neverCalled() {
  assert.fail('Should never be called');
}

function getTestOptions() {
  return {
    env: Object.create(null),
    bisectRange: neverCalled,
    stdin: new stream.PassThrough(),
    stdout: new stream.PassThrough({ encoding: 'utf8' }),
    stderr: new stream.PassThrough({ encoding: 'utf8' }),
  };
}

describe('noderegression command', () => {
  it('throws TypeError with no arguments', () => {
    return assert.rejects(
      noderegressionMain,
      TypeError,
    );
  });

  it('throws TypeError for non-array-like args', () => {
    return assert.rejects(
      () => noderegressionMain({}, getTestOptions()),
      TypeError,
    );
  });

  it('throws Error for empty args', () => {
    return assert.rejects(
      () => noderegressionMain([], getTestOptions()),
      Error,
    );
  });

  it('throws Error for one arg', () => {
    return assert.rejects(
      () => noderegressionMain(['node'], getTestOptions()),
      Error,
    );
  });

  it('throws TypeError for non-object options', () => {
    return assert.rejects(
      () => noderegressionMain(testRuntimeArgs, true),
      TypeError,
    );
  });

  it('throws TypeError for non-Readable stdin', () => {
    const options = {
      ...getTestOptions(),
      stdin: {},
    };
    return assert.rejects(
      () => noderegressionMain(testRuntimeArgs, options),
      TypeError,
    );
  });

  it('throws TypeError for non-Writable stdout', () => {
    const options = {
      ...getTestOptions(),
      stdout: new stream.Readable(),
    };
    return assert.rejects(
      () => noderegressionMain(testRuntimeArgs, options),
      TypeError,
    );
  });

  it('throws TypeError for non-Writable stderr', () => {
    const options = {
      ...getTestOptions(),
      stderr: new stream.Readable(),
    };
    return assert.rejects(
      () => noderegressionMain(testRuntimeArgs, options),
      TypeError,
    );
  });

  it('writes last/first to stderr by default', async () => {
    const bisectRange = sinon.stub().resolves(testGoodBad);
    const options = {
      ...getTestOptions(),
      bisectRange,
    };
    const exitCode =
      await noderegressionMain([...testRuntimeArgs, 'cmd'], options);
    sinon.assert.callCount(bisectRange, 1);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(options.stdout.read(), null);
    assert.strictEqual(options.stderr.read(), testGoodBadOut);
  });

  it('writes "None found" for missing last/first', async () => {
    const bisectRange = sinon.stub().resolves([undefined, undefined]);
    const options = {
      ...getTestOptions(),
      bisectRange,
    };
    const exitCode =
      await noderegressionMain([...testRuntimeArgs, 'cmd'], options);
    sinon.assert.callCount(bisectRange, 1);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(options.stdout.read(), null);
    assert.strictEqual(
      options.stderr.read(),
      'Last good build: None found\n'
      + 'First bad build: None found\n',
    );
  });

  it('does not write last/first if --quiet', async () => {
    const bisectRange = sinon.stub().resolves(testGoodBad);
    const options = {
      ...getTestOptions(),
      bisectRange,
    };
    const exitCode =
      await noderegressionMain([...testRuntimeArgs, '--quiet', 'cmd'], options);
    sinon.assert.callCount(bisectRange, 1);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(options.stdout.read(), null);
    assert.strictEqual(options.stderr.read(), null);
  });

  it('writes error to stderr with exit code 1', async () => {
    const errTest = new Error('test');
    const bisectRange = sinon.stub().rejects(errTest);
    const options = {
      ...getTestOptions(),
      bisectRange,
    };
    const exitCode =
      await noderegressionMain([...testRuntimeArgs, '--quiet', 'cmd'], options);
    sinon.assert.callCount(bisectRange, 1);
    assert.strictEqual(exitCode, 1);
    assert.strictEqual(options.stdout.read(), null);
    assert.strictEqual(
      options.stderr.read(),
      `${errTest}\n`,
    );
  });

  for (const helpOpt of ['--help', '-h']) {
    it(`${helpOpt} prints help message to stdout`, async () => {
      const args = [...testRuntimeArgs, helpOpt];
      const options = getTestOptions();
      const exitCode = await noderegressionMain(args, options);
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(options.stderr.read(), null);
      const output = options.stdout.read();
      assert(output, 'produces help output');
      assert.match(output, /--verbose\b/);
    });
  }

  for (const versionOpt of ['--version', '-V']) {
    it(`${versionOpt} prints version message to stdout`, async () => {
      const args = [...testRuntimeArgs, versionOpt];
      const options = getTestOptions();
      const exitCode = await noderegressionMain(args, options);
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(options.stderr.read(), null);
      const output = options.stdout.read();
      assert.strictEqual(output, `${packageJson.version}\n`);
    });
  }

  it('passes options.console from options.stderr', async () => {
    const bisectRange = sinon.stub().returns(new Promise(() => {}));
    const options = {
      ...getTestOptions(),
      bisectRange,
    };
    noderegressionMain([...testRuntimeArgs, 'cmd'], options);
    await setImmediateP();
    sinon.assert.callCount(bisectRange, 1);
    const brOptions = bisectRange.getCall(0).args[3];
    // eslint-disable-next-line no-console
    assert(brOptions.console instanceof console.Console);
    brOptions.console.info('info test');
    brOptions.console.error('error test');
    assert.strictEqual(options.stdout.read(), null);
    assert.strictEqual(options.stderr.read(), 'info test\nerror test\n');
  });

  it('passes through options.env', async () => {
    const bisectRange = sinon.stub().resolves(testGoodBad);
    const testEnv = {};
    const options = {
      ...getTestOptions(),
      bisectRange,
      env: testEnv,
    };
    const exitCode =
      await noderegressionMain([...testRuntimeArgs, 'cmd'], options);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(options.stderr.read(), testGoodBadOut);
    assert.strictEqual(options.stdout.read(), null);

    sinon.assert.callCount(bisectRange, 1);
    const brOptions = bisectRange.getCall(0).args[3];
    assert.strictEqual(brOptions.env, testEnv);
  });

  function expectArgsAs(args, expectGood, expectBad, expectCmd, expectOptions) {
    assert(Object.getPrototypeOf(args), Array.prototype);
    assert(Object.getPrototypeOf(expectCmd), Array.prototype);

    const testDesc =
      `interprets ${args.join(' ')} as ${expectCmd.join(' ')}, ${
        expectOptions}`;
    it(testDesc, async () => {
      const allArgs = [...testRuntimeArgs, ...args];
      const bisectRange = sinon.stub().resolves(testGoodBad);
      const options = {
        ...getTestOptions(),
        bisectRange,
      };
      const exitCode = await noderegressionMain(allArgs, options);
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(options.stderr.read(), testGoodBadOut);
      assert.strictEqual(options.stdout.read(), null);
      sinon.assert.calledOnceWithExactly(
        bisectRange,
        expectGood,
        expectBad,
        expectCmd,
        expectOptions,
      );
    });
  }

  // Check individual arguments are handled correctly
  expectArgsAs(['cmd'], undefined, undefined, ['cmd'], match({
    targets: undefined,
  }));
  expectArgsAs(['--', 'cmd'], undefined, undefined, ['cmd'], match({
    targets: undefined,
  }));
  expectArgsAs(['--', 'cmd', '-g'], undefined, undefined, ['cmd', '-g'], match({
    targets: undefined,
  }));
  expectArgsAs(['cmd', '-g'], undefined, undefined, ['cmd', '-g'], match({
    targets: undefined,
  }));
  expectArgsAs(
    ['--bad', '2020-01-02', 'cmd'],
    undefined,
    new Date(Date.UTC(2020, 0, 2)),
    ['cmd'],
    match({ targets: undefined }),
  );
  expectArgsAs(
    ['-b', new Date(2020, 0, 2).toLocaleDateString(), 'cmd'],
    undefined,
    new Date(Date.UTC(2020, 0, 2)),
    ['cmd'],
    match({ targets: undefined }),
  );
  expectArgsAs(
    ['--new', new Date(2020, 0, 2).toString(), 'cmd'],
    undefined,
    new Date(Date.UTC(2020, 0, 2)),
    ['cmd'],
    match({ targets: undefined }),
  );
  // Passes earliest bad date in either order
  expectArgsAs(
    ['-b', '2020-01-02', '--bad', '2020-01-03', 'cmd'],
    undefined,
    new Date(Date.UTC(2020, 0, 2)),
    ['cmd'],
    match({ targets: undefined }),
  );
  expectArgsAs(
    ['--bad', '2020-01-03', '--bad', '2020-01-02', 'cmd'],
    undefined,
    new Date(Date.UTC(2020, 0, 2)),
    ['cmd'],
    match({ targets: undefined }),
  );
  expectArgsAs(
    ['--good', '2020-01-02', 'cmd'],
    new Date(Date.UTC(2020, 0, 2)),
    undefined,
    ['cmd'],
    match({ targets: undefined }),
  );
  expectArgsAs(
    ['-g', new Date(2020, 0, 2).toLocaleDateString(), 'cmd'],
    new Date(Date.UTC(2020, 0, 2)),
    undefined,
    ['cmd'],
    match({ targets: undefined }),
  );
  expectArgsAs(
    ['--old', new Date(2020, 0, 2).toString(), 'cmd'],
    new Date(Date.UTC(2020, 0, 2)),
    undefined,
    ['cmd'],
    match({ targets: undefined }),
  );
  // Passes latest good date in either order
  expectArgsAs(
    ['-g', '2020-01-02', '--good', '2020-01-03', 'cmd'],
    new Date(Date.UTC(2020, 0, 3)),
    undefined,
    ['cmd'],
    match({ targets: undefined }),
  );
  expectArgsAs(
    ['--good', '2020-01-03', '--good', '2020-01-02', 'cmd'],
    new Date(Date.UTC(2020, 0, 3)),
    undefined,
    ['cmd'],
    match({ targets: undefined }),
  );
  expectArgsAs(
    ['--target', 'aix-ppc64', 'cmd'],
    undefined,
    undefined,
    ['cmd'],
    match({ targets: ['aix-ppc64'] }),
  );
  expectArgsAs(
    ['--target', 'aix-ppc64', '--target', 'osx-x64-pkg', 'cmd'],
    undefined,
    undefined,
    ['cmd'],
    match({ targets: ['aix-ppc64', 'osx-x64-pkg'] }),
  );

  it('--log - cmd saves log to stdout', async () => {
    const allArgs = [...testRuntimeArgs, '--log', '-', 'cmd'];
    let resolveBisect;
    const bisectRange = sinon.stub().returns(new Promise((resolve) => {
      resolveBisect = resolve;
    }));
    const options = {
      ...getTestOptions(),
      bisectRange,
    };
    const exitCodeP = noderegressionMain(allArgs, options);
    await setImmediateP();
    sinon.assert.callCount(bisectRange, 1);
    const brOptions = bisectRange.getCall(0).args[3];
    brOptions.listeners.onresult(buildIndex[2], 1, null);
    brOptions.listeners.onresult(buildIndex[1], 0, null);
    brOptions.listeners.onresult(buildIndex[0], null, 'SIGSEGV');
    resolveBisect(testGoodBad);
    const exitCode = await exitCodeP;
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(options.stderr.read(), testGoodBadOut);
    assert.strictEqual(
      options.stdout.read(),
      '# bad: v16.0.0-nightly20210216eec20ed5c1\n'
      + 'git bisect bad eec20ed5c1\n'
      + '# good: v16.0.0-nightly202102178353854ed7\n'
      + 'git bisect good 8353854ed7\n'
      + '# bad: v16.0.0-nightly202102189a2ac2c615\n'
      + 'git bisect bad 9a2ac2c615\n',
    );
  });

  it('-l filename cmd saves log to filename', async () => {
    const logPath = await tmpName();
    const allArgs = [...testRuntimeArgs, '-l', logPath, 'cmd'];
    let resolveBisect;
    const bisectRange = sinon.stub().returns(new Promise((resolve) => {
      resolveBisect = resolve;
    }));
    const options = {
      ...getTestOptions(),
      bisectRange,
    };
    try {
      const exitCodeP = noderegressionMain(allArgs, options);
      // FIXME: No easy way to wait for open event
      await setTimeoutP(1000);
      sinon.assert.callCount(bisectRange, 1);
      const brOptions = bisectRange.getCall(0).args[3];
      brOptions.listeners.onresult(buildIndex[2], 1, null);
      brOptions.listeners.onresult(buildIndex[1], 0, null);
      brOptions.listeners.onresult(buildIndex[0], null, 'SIGSEGV');
      resolveBisect(testGoodBad);
      const exitCode = await exitCodeP;
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(options.stdout.read(), null);
      assert.strictEqual(options.stderr.read(), testGoodBadOut);

      const logContents = await readFile(logPath, { encoding: 'utf8' });
      assert.strictEqual(
        logContents,
        '# bad: v16.0.0-nightly20210216eec20ed5c1\n'
        + 'git bisect bad eec20ed5c1\n'
        + '# good: v16.0.0-nightly202102178353854ed7\n'
        + 'git bisect good 8353854ed7\n'
        + '# bad: v16.0.0-nightly202102189a2ac2c615\n'
        + 'git bisect bad 9a2ac2c615\n',
      );
    } finally {
      try {
        unlink(logPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // eslint-disable-next-line no-unsafe-finally
          throw err;
        }
      }
    }
  });

  function expectArgsLogLevels(args, expectLevels) {
    it(`with ${args.join(' ')} only logs to ${expectLevels}`, async () => {
      const allArgs = [...testRuntimeArgs, ...args, 'cmd'];
      const bisectRange = sinon.stub().resolves(new Promise(() => {}));
      const options = {
        ...getTestOptions(),
        bisectRange,
      };
      noderegressionMain(allArgs, options);
      await setImmediateP();
      sinon.assert.callCount(bisectRange, 1);
      assert.strictEqual(options.stdout.read(), null);

      const { console: brConsole } = bisectRange.getCall(0).args[3];
      for (const level of ['debug', 'info', 'warn', 'error']) {
        brConsole[level](level);
      }
      assert.strictEqual(
        options.stderr.read(),
        `${expectLevels.join('\n')}\n`,
      );
    });
  }

  expectArgsLogLevels([], ['info', 'warn', 'error']);
  expectArgsLogLevels(['--quiet'], ['warn', 'error']);
  expectArgsLogLevels(['-q'], ['warn', 'error']);
  expectArgsLogLevels(['-qq'], ['error']);
  expectArgsLogLevels(['--verbose'], ['debug', 'info', 'warn', 'error']);
  expectArgsLogLevels(['-v'], ['debug', 'info', 'warn', 'error']);
  expectArgsLogLevels(['-vv'], ['debug', 'info', 'warn', 'error']);
  expectArgsLogLevels(['-vq'], ['info', 'warn', 'error']);
  expectArgsLogLevels(['-qv'], ['info', 'warn', 'error']);

  function expectArgsErr(args, expectErrMsg) {
    it(`prints error and exits for ${args.join(' ')}`, async () => {
      const allArgs = [...testRuntimeArgs, ...args];
      const options = getTestOptions();
      const exitCode = await noderegressionMain(allArgs, options);
      assert.strictEqual(exitCode, 1);
      assert.strictEqual(options.stdout.read(), null);
      assert.match(options.stderr.read(), expectErrMsg);
    });
  }

  // Check argument errors are handled correctly
  expectArgsErr([], /\btest_command\b/i);
  expectArgsErr(['--'], /\btest_command\b/i);
  expectArgsErr(['--bad', '2020-01-02'], /\btest_command\b/i);
  expectArgsErr(['--bad', '2020-01-02', '--'], /\btest_command\b/i);
  expectArgsErr(['--target', 'abc'], /\btest_command\b/i);
  expectArgsErr(['--bad', 'invalid', 'cmd'], /\bdate\b/i);
  expectArgsErr(
    ['--bad', new Date(2020, 0, 1, 2, 3).toISOString(), 'cmd'],
    /\bdate\b/i,
  );
  expectArgsErr(['--bad', '', 'cmd'], /\bdate\b/i);
  expectArgsErr(['-b', '--', 'cmd'], /\bdate\b/i);
  expectArgsErr(['--good', 'invalid', 'cmd'], /\bdate\b/i);
  expectArgsErr(
    ['--good', new Date(2020, 0, 1, 2, 3).toISOString(), 'cmd'],
    /\bdate\b/i,
  );
  expectArgsErr(['--good', '', 'cmd'], /\bdate\b/i);
  expectArgsErr(['-g', '--', 'cmd'], /\bdate\b/i);
  expectArgsErr(['--log', '', 'cmd'], /\blog\b/i);
  // Note: getopt libraries differ on how this is handled.
  // commander treats -- as optarg for preceding option, which is not an error.
  // expectArgsErr(['--log', '--', 'cmd'], /\blog\b/i);
  // expectArgsErr(['--target', '--', 'cmd'], /\btarget\b/i);
  expectArgsErr(['--unknown123'], /\bunknown123\b/);

  it('prints bisectRange rejection to stderr', async () => {
    const errTest = new RangeError('test');
    const bisectRange = sinon.stub().rejects(errTest);
    const options = {
      ...getTestOptions(),
      bisectRange,
    };
    const exitCode =
      await noderegressionMain([...testRuntimeArgs, 'cmd'], options);
    assert.strictEqual(exitCode, 1);
    assert.strictEqual(options.stdout.read(), null);
    assert.match(options.stderr.read(), new RegExp(errTest));
  });
});
