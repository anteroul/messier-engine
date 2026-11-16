// Cuts a release: bumps the version in package.json and package-lock.json, turns the change log's Unreleased
// section into that version, and refreshes flake.nix's npmDepsHash (Nix's snapshot of the npm dependencies includes
// the lockfile, so its version field changes the hash). Doesn't commit or tag; it prints those steps.
// Run via `npm run release -- <patch|minor|major|x.y.z>`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = (f) => resolve(root, f);
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const bump = process.argv[2];
if (!bump) fail('usage: npm run release -- <patch|minor|major|x.y.z>');

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) fail('commit or stash your changes first, so the release commit holds only the release');

const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8'));
const current = pkg.version;
const parts = current.split('.').map(Number);
let next;
if (bump === 'major') next = `${parts[0] + 1}.0.0`;
else if (bump === 'minor') next = `${parts[0]}.${parts[1] + 1}.0`;
else if (bump === 'patch') next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else fail(`"${bump}" is not patch, minor, major or a version like 1.2.3`);
const newer = next.split('.').map(Number).some((v, i, a) => a.slice(0, i).every((x, j) => x === parts[j]) && v > parts[i]);
if (!newer) fail(`${next} is not newer than ${current}`);

// Change log: the Unreleased section becomes the new version, and a fresh empty one goes on top.
let log = readFileSync(path('CHANGELOG.md'), 'utf8');
const start = log.indexOf('## [Unreleased]');
if (start < 0) fail('CHANGELOG.md has no "## [Unreleased]" section');
const bodyStart = start + '## [Unreleased]'.length;
const end = log.indexOf('\n## [', bodyStart);
const body = log.slice(bodyStart, end < 0 ? undefined : end);
if (!body.trim()) fail('nothing under "## [Unreleased]" in CHANGELOG.md: describe the changes first');
const date = new Date().toISOString().slice(0, 10);
log = `${log.slice(0, bodyStart)}\n\n## [${next}] - ${date}${body.replace(/\s*$/, '\n')}${end < 0 ? '' : log.slice(end)}`;
// Compare links at the bottom, when there are any.
log = log.replace(/^\[Unreleased\]: (.*)\/compare\/v[^.\s]+\.[^.\s]+\.[^.\s]+\.\.\.HEAD$/m, (_, base) =>
  `[Unreleased]: ${base}/compare/v${next}...HEAD\n[${next}]: ${base}/compare/v${current}...v${next}`);
writeFileSync(path('CHANGELOG.md'), log);

pkg.version = next;
writeFileSync(path('package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
const lock = JSON.parse(readFileSync(path('package-lock.json'), 'utf8'));
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
writeFileSync(path('package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);

let hashNote = '';
try {
  const hash = execFileSync('nix', ['run', 'nixpkgs#prefetch-npm-deps', '--', 'package-lock.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim().split('\n').pop();
  const flake = readFileSync(path('flake.nix'), 'utf8');
  if (!/^sha256-/.test(hash) || !/npmDepsHash = "[^"]*";/.test(flake)) throw new Error('unexpected output');
  writeFileSync(path('flake.nix'), flake.replace(/npmDepsHash = "[^"]*";/, `npmDepsHash = "${hash}";`));
} catch {
  hashNote = '\nCouldn\'t update npmDepsHash in flake.nix (needs nix). Run `nix run nixpkgs#prefetch-npm-deps -- package-lock.json`\nand put the result there, or `nix build` fails.\n';
}

console.log(`${hashNote}Version ${current} → ${next}. Check CHANGELOG.md, then:

  git commit -am "Release ${next}"
  git tag -a v${next} -m "Release ${next}"
  git push --follow-tags`);
