Noderegression
==============

[![Build Status](https://img.shields.io/github/workflow/status/kevinoid/noderegression/Node.js%20CI/main.svg?style=flat&label=build)](https://github.com/kevinoid/noderegression/actions?query=branch%3Amain)
[![Coverage](https://img.shields.io/codecov/c/github/kevinoid/noderegression.svg?style=flat)](https://codecov.io/github/kevinoid/noderegression?branch=main)
[![Dependency Status](https://img.shields.io/david/kevinoid/noderegression.svg?style=flat)](https://david-dm.org/kevinoid/noderegression)
[![Supported Node Version](https://img.shields.io/node/v/noderegression.svg?style=flat)](https://www.npmjs.com/package/noderegression)
[![Version on NPM](https://img.shields.io/npm/v/noderegression.svg?style=flat)](https://www.npmjs.com/package/noderegression)

An automated tool for regression range-finding in the [Node.js
runtime](https://nodejs.org/) using [nightly
builds](https://nodejs.org/download/nightly/).  A Node.js equivalent of
[mozregression](http://mozilla.github.com/mozregression/).

Bisecting regressions in the Node.js runtime using [`git
bisect`](https://git-scm.com/docs/git-bisect) can be quite slow on systems
where building Node.js takes a long time.  This tool aims to significantly
reduce the time by bisecting using pre-compiled nightly builds.  Once the
first nightly build to exhibit a regression is located, the specific commit
may be located by inspection or by passing the log to `git bisect replay`
to continue bisection on the commits between the daily builds.

## Introductory Examples

Suppose the introduction of
[`queueMicrotask`](https://nodejs.org/api/globals.html#globals_queuemicrotask_callback)
was a mistake.  To bisect, we can invoke `node` with with code to evaluate
using the `-e` option.  If `queueMicrotask` is a function, the build is bad
(exit code 1), if not it is good (exit code 0).

```sh
nodebisect -- -e 'process.exitCode = typeof queueMicrotask === "function" ? 1 : 0'
```

More commonly the regression test is present in a script (e.g. `regtest.js`):

```sh
nodebisect regtest.js
```

## Features

* Caches downloaded builds in
  [`$XDG_CACHE_HOME`](https://specifications.freedesktop.org/basedir-spec/latest/ar01s03.html)
  (or `~/AppData/Local` on Windows).

## Installation

[This package](https://www.npmjs.com/package/noderegression) can be
installed using [npm](https://www.npmjs.com/), either globally or locally, by
running:

```sh
npm install noderegression
```

## Recipes

More examples can be found in the [test
specifications](https://kevinoid.github.io/noderegression/spec).

## API Docs

To use this module as a library, see the [API
Documentation](https://kevinoid.github.io/noderegression/api).

## Contributing

Contributions are appreciated.  Contributors agree to abide by the [Contributor
Covenant Code of
Conduct](https://www.contributor-covenant.org/version/1/4/code-of-conduct.html).
If this is your first time contributing to a Free and Open Source Software
project, consider reading [How to Contribute to Open
Source](https://opensource.guide/how-to-contribute/)
in the Open Source Guides.

If the desired change is large, complex, backwards-incompatible, can have
significantly differing implementations, or may not be in scope for this
project, opening an issue before writing the code can avoid frustration and
save a lot of time and effort.

## License

This project is available under the terms of the [MIT License](LICENSE.txt).
See the [summary at TLDRLegal](https://tldrlegal.com/license/mit-license).
