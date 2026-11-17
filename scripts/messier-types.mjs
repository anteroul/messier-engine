// Builds `messier.d.ts`: the type declarations of the engine API that scripts import from 'messier', in one file,
// so editors like VS Code can type-check and autocomplete a project's scripts. The editor writes it into project
// folders as .messier/messier.d.ts (with a tsconfig.json that includes it).
//
// TypeScript can bundle declarations into one file only for AMD/System modules: each engine file becomes a
// `declare module "messier/engine/<file>"` block, and a last block re-exports the barrel as "messier".
//   node scripts/messier-types.mjs          prints it
//   import { buildMessierTypes } from …     the Vite plugin and scripts/generate-demo-project.mjs
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TYPES_FILE = 'messier.d.ts';

/** The declarations as text. Throws with tsc's messages when the engine doesn't compile. */
export function buildMessierTypes(root = fileURLToPath(new URL('..', import.meta.url))) {
  const src = `${root}/src`;
  const { version } = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  let out = '';
  const program = ts.createProgram([`${src}/engine/index.ts`], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.System,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: ['@webgpu/types', 'vite/client'],
    typeRoots: [`${root}/node_modules/@types`, `${root}/node_modules`],
    strict: true,
    skipLibCheck: true,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: src,
    outFile: 'messier.d.ts',
  });
  const result = program.emit(undefined, (_name, text) => (out = text));
  const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length || !out) {
    throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' }) || 'No declarations emitted');
  }
  // Under messier/ so the module names can't clash with anything in a project.
  const body = out.replace(/"engine\//g, '"messier/engine/');
  return `// Messier ${version}: types of the 'messier' module scripts import from. Written by the Messier editor; it's
// replaced when the project opens in a different version, so don't edit it.

${body}
declare module "messier" {
    export * from "messier/engine/index";
}
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.stdout.write(buildMessierTypes());
