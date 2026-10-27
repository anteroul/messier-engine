// Release-build property mangling. Engine and editor code marks internal members with a leading `_`; production
// builds rename them, so nothing outside can depend on them (and the bundle shrinks). Two rules keep that safe:
// - Mangled names stay `_`-prefixed (`_registry` → `_$1f`). Engine code tells internal fields from public ones by
//   that prefix at runtime (Component.clone/toJSON, Behaviour.paramNames, script hot swap).
// - They can't collide with fields that user scripts, compiled in the browser, declare on Script subclasses, which
//   esbuild's default short names (`a`, `b`, …) would.
// Vite runs esbuild on each module and again on each chunk. So the cache has to name everything up front (modules
// would otherwise choose different names), and already-mangled `_$…` names must not match a second time.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /(?<![\w$])_[A-Za-z_][\w$]*/g;

/** esbuild options for mangling `_` properties of the sources under `srcDir`. */
export function mangleOptions(srcDir) {
  const root = srcDir instanceof URL ? fileURLToPath(srcDir) : srcDir;
  const names = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (/\.(ts|js|mjs)$/.test(e.name)) for (const m of readFileSync(path, 'utf8').matchAll(NAME)) names.add(m[0]);
    }
  };
  walk(root);
  const mangleCache = {};
  [...names].sort().forEach((name, i) => (mangleCache[name] = `_$${i.toString(36)}`));
  // esbuild takes Go regexps (no lookahead): `_` followed by anything but `$`.
  return { mangleProps: /^_[^$]/, mangleCache };
}
