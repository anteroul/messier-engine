import { readFileSync } from 'node:fs';
import { check, eq } from './harness';

// The version lives in package.json (the editor and the Nix build read it from there). npm run release keeps
// package-lock.json and the change log in step; this catches a hand edit that didn't.

const root = process.env.PROJECT_ROOT!;
const read = (f: string) => readFileSync(`${root}/${f}`, 'utf8');
const version = JSON.parse(read('package.json')).version as string;
const lock = JSON.parse(read('package-lock.json'));
const log = read('CHANGELOG.md');

check('version is x.y.z', /^\d+\.\d+\.\d+$/.test(version), version);
eq('package-lock.json has the same version', [lock.version, lock.packages?.['']?.version], [version, version]);
check('the change log has an Unreleased section', log.includes('\n## [Unreleased]\n'));
const released = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m.exec(log)?.[1];
eq('the newest change log entry is the current version (bump it with npm run release)', released, version);
check('flake.nix reads the version from package.json', /version = \(builtins\.fromJSON \(builtins\.readFile \.\/package\.json\)\)\.version;/.test(read('flake.nix')));
