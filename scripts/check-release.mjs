/** Verifies the immutable release tag and prevents publishing prerelease RPC dependencies as stable. */
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Parsing rather than checking for a hyphen distinguishes prereleases from build metadata.
function hasPrerelease(version, label) {
  const match =
    typeof version === 'string'
      ? /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version)
      : null;
  const hasLeadingZero = (part) => /^0\d+$/u.test(part);
  if (!match || match[0] !== version || match.slice(1, 4).some(hasLeadingZero) || match[4]?.split('.').some(hasLeadingZero)) {
    throw new Error(`${label} must be a valid exact SemVer version`);
  }
  return match[4] !== undefined;
}

/** Returns the npm release channel only when the package and tag are safe to publish together. */
export function releaseNpmTag(packageJson, tag) {
  const prerelease = hasPrerelease(packageJson.version, 'package.json version');
  if (tag !== `v${packageJson.version}`) {
    throw new Error(`Release tag ${tag} must exactly match v${packageJson.version}`);
  }
  for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
    if (!name.startsWith('@orpc/')) continue;
    const dependencyPrerelease = hasPrerelease(version, `${name} dependency`);
    if (!prerelease && dependencyPrerelease) {
      throw new Error(`Stable releases cannot depend on prerelease ${name}@${version}`);
    }
  }
  return prerelease ? 'next' : 'latest';
}

// Importing the pure helper in tests must never write GitHub workflow outputs.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const npmTag = releaseNpmTag(packageJson, process.env.RELEASE_TAG);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `NPM_TAG=${npmTag}\n`);
  console.log(npmTag);
}
