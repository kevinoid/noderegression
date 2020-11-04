/**
 * Functions for getting Node.js build target names from OS information.
 *
 * @copyright Copyright 2016-2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const { debuglog } = require('util');

const debug = debuglog('get-node-targets-for-os');

/** Gets the ARM architecture versions for Node.js builds which are compatible
 * with a given OS.
 *
 * @private
 * @param {!{
 *   cpus: (function(): !Array<!{model: string}>)
 * }} os Subset of the os module used for determining the ARM version.
 * @returns {!Array<string>} ARM architecture versions for Node.js build target
 * names which are compatible with the given OS, from highest to lowest
 * preference.
 */
function getArmVersionsForOS(os) {
  // Parse elf_platform (elf_name + endianness) from model name
  // https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm/kernel/setup.c?h=v5.9#n1250
  // Can get list of current names via `grep cpu_elf_name, arch/arm/mm/*.S`
  //
  // Note: /proc/cpuinfo has "CPU architecture: " line with version from CPUID
  // https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm/kernel/setup.c?h=v5.9#n1274
  // https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm/kernel/setup.c?h=v5.9#n218
  // Is there a case where it would differ from elf_name?
  const cpus = os.cpus();
  const model = cpus && cpus[0] && cpus[0].model;
  const match = model && / \((v([0-9]+)(.*)([bl])|.*)\)$/.exec(model);
  if (!match) {
    debug(`Warning: ELF platform not found in CPU model "${model}".`);
    return ['arm'];
  }

  // eslint-disable-next-line no-unused-vars
  const [_, elfPlatform, armVerNum, armVerSuffix, endianness] = match;
  const armVersions = [`arm${elfPlatform}`];
  if (armVerNum) {
    if (armVerSuffix) {
      // If ARM version has non-numeric suffix (e.g. v7m, v5t), try without it
      armVersions.push(`armv${armVerNum}${endianness}`);
    }

    // Try previous ARM versions.
    // Note: nodejs.org currently only has builds for v6l and v7l
    for (let armVer = armVerNum - 1; armVer > 5; armVer -= 1) {
      armVersions.push(`armv${armVerNum}${endianness}`);
    }
  }

  return armVersions;
}

/** Gets a list of Node.js build target names, in order of preference, suitable
 * for a given OS.
 *
 * The target name is the name used for the Node.js archive on
 * https://nodejs.org/download/ not a GNU Triplet.
 *
 * @param {!{
 *   arch: function(): string,
 *   cpus: function(): !Array<!{model: string}>,
 *   endianness: function(): string,
 *   platform: function(): string
 * }} os Subset of the os module used for determining the build target names.
 * @returns {!Array<string>} Node.js build target names which are compatible
 * with the given OS, from highest to lowest preference.
 */
module.exports =
function getNodeTargetsForOS(os) {
  let platform = os.platform();
  switch (platform) {
    case 'darwin':
      platform = 'osx';
      break;
    case 'win32':
      platform = 'win';
      break;
    default:
      // platform matches target name.  Leave as-is.
      break;
  }

  let arch = os.arch();
  let targets;
  switch (arch) {
    case 'arm':
      targets = getArmVersionsForOS(os)
        .map((armVer) => `${platform}-${armVer}`);
      break;

    case 'ia32':
    case 'x32':
      targets = [`${platform}-x86`];
      break;

    case 'ppc64':
      if (os.endianness() === 'LE') {
        arch += 'le';
      }
      targets = [`${platform}-${arch}`];
      break;

    default:
      targets = [`${platform}-${arch}`];
      break;
  }

  return targets.flatMap((target) => {
    switch (platform) {
      case 'osx':
        return [
          `${target}-tar`,
          `${target}-pkg`,
        ];

      case 'win':
        return [
          `${target}-exe`,
          `${target}-zip`,
          `${target}-7z`,
          `${target}-msi`,
        ];

      default:
        return target;
    }
  });
};
