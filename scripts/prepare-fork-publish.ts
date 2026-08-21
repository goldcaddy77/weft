/**
 * Rewrite package.json in place so the built tree can be published to GitHub
 * Packages under the scope this fork's owner actually controls.
 *
 * Why this exists: the upstream package name is `@lostgradient/weft`, an npm
 * scope owned by the upstream author. This fork carries two fixes that are
 * deliberately not upstreamed (PR #2 — the workflow visibility index backfill;
 * PR #3 — purging oversized workflows past the storage batch cap), and
 * downstream consumers need a real, versioned tarball rather than a git
 * dependency: the package's `prepare` script is husky, not a build, so a git
 * dependency installs with no `dist/` at all.
 *
 * The rename is applied at publish time rather than committed so that `main`
 * stays a clean `upstream + two fixes`, which is what keeps rebasing onto a new
 * upstream release cheap.
 *
 * Usage: bun run scripts/prepare-fork-publish.ts <version>
 */

const FORK_PACKAGE_NAME = '@goldcaddy77/weft';
const FORK_REGISTRY = 'https://npm.pkg.github.com';

const version = process.argv[2];

if (!version) {
  console.error('usage: bun run scripts/prepare-fork-publish.ts <version>');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`refusing to publish a non-semver version: ${version}`);
  process.exit(1);
}

const path = new URL('../package.json', import.meta.url);
const manifest = await Bun.file(path).json();

const upstreamName = manifest.name;
const upstreamVersion = manifest.version;

manifest.name = FORK_PACKAGE_NAME;
manifest.version = version;
manifest.description = `${manifest.description} (goldcaddy77 fork of ${upstreamName}@${upstreamVersion}, plus the visibility-backfill and oversized-purge fixes)`;
manifest.repository = { type: 'git', url: 'git+https://github.com/goldcaddy77/weft.git' };
manifest.publishConfig = { registry: FORK_REGISTRY, access: 'restricted' };

// These gates are authored against the upstream name and version and would
// reject the renamed manifest. The publish workflow runs the real build and the
// upstream `validate` suite separately, before this script ever runs.
delete manifest.scripts?.prepack;
delete manifest.scripts?.prepublishOnly;
delete manifest.scripts?.prepare;

// Every peer here is a pick-one-if-you-need-it adapter (a storage driver, the
// OTel API, the console), but the manifest declares no `peerDependenciesMeta`,
// so a strict installer treats all of them as REQUIRED. That is merely noisy for
// the ones on npm and fatal for `@lostgradient/weft-console`, which upstream has
// never published to any registry — pnpm dies with ERR_PNPM_FETCH_404 and the
// install cannot complete at all. Marking them optional is what the upstream
// README already tells people they are.
if (manifest.peerDependencies) {
  manifest.peerDependenciesMeta = Object.fromEntries(
    Object.keys(manifest.peerDependencies).map((name) => [name, { optional: true }]),
  );
}

await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `prepared ${upstreamName}@${upstreamVersion} for publish as ${FORK_PACKAGE_NAME}@${version}`,
);
