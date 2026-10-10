import type { LanguageSpec } from '@second-look/engine';

/**
 * The files the tree-sitter runtime loads beside the grammars: the
 * emscripten glue `@vscode/tree-sitter-wasm` resolves as its main and
 * the core WASM binary that glue fetches next to itself.
 */
const RUNTIME_GRAMMAR_FILES: readonly string[] = ['tree-sitter.js', 'tree-sitter.wasm'];

/**
 * The WASM files the package carries: the runtime's own two files plus
 * exactly the grammars the engine's language list names, so the package
 * stays as small as the languages it can parse and never misses one the
 * engine will ask for at review time.
 */
export function grammarFilesFor(
  languages: readonly Pick<LanguageSpec, 'grammar'>[],
): string[] {
  const files = new Set<string>(RUNTIME_GRAMMAR_FILES);
  for (const language of languages) {
    files.add(language.grammar);
  }
  return [...files].sort();
}

/** The manifest fields the staged engine package keeps: enough for the
 * extension's `require.resolve('@second-look/engine/package.json')` to
 * find the bundled engine, and nothing that invites a tool to treat the
 * bundled copy as an installable package. */
export function stagedEngineManifest(
  manifest: { name: string; version: string } & Record<string, unknown>,
): { name: string; version: string; type: 'module' } {
  return { name: manifest.name, version: manifest.version, type: 'module' };
}

/** The manifest fields the packaged extension keeps. */
const EXTENSION_MANIFEST_FIELDS: readonly string[] = [
  'name',
  'displayName',
  'description',
  'version',
  'license',
  'publisher',
  'repository',
  'type',
  'engines',
  'categories',
  'capabilities',
  'main',
  'contributes',
];

/** The two packages the package carries under `node_modules`, at their staged versions. */
export interface StagedDependencies {
  '@second-look/engine': string;
  '@vscode/tree-sitter-wasm': string;
}

/**
 * The extension's manifest as the package carries it: everything the
 * editor reads, without the workspace's own build wiring (`scripts`,
 * `devDependencies`, `exports`, `types`), because the package's code is
 * one bundled file. The `dependencies` it declares are exactly the two
 * packages staged under `node_modules`, at the versions staged there, so
 * the packager's own dependency walk carries them into the file — and
 * nothing else.
 */
export function stagedExtensionManifest(
  manifest: Record<string, unknown>,
  dependencies: StagedDependencies,
): Record<string, unknown> {
  const staged: Record<string, unknown> = {};
  for (const field of EXTENSION_MANIFEST_FIELDS) {
    if (field in manifest) {
      staged[field] = manifest[field];
    }
  }
  staged['dependencies'] = { ...dependencies };
  return staged;
}

/**
 * The icon files the manifest's view containers point at, relative to
 * the extension's root: the package carries each one at the same path,
 * so the Activity Bar finds its icon in an installed package exactly as
 * it does in the repository.
 */
export function viewContainerIconFiles(manifest: Record<string, unknown>): string[] {
  const contributes = manifest['contributes'] as
    | { viewsContainers?: Record<string, { icon?: unknown }[]> }
    | undefined;
  const files = new Set<string>();
  for (const containers of Object.values(contributes?.viewsContainers ?? {})) {
    for (const container of containers) {
      if (typeof container.icon === 'string') {
        files.add(container.icon);
      }
    }
  }
  return [...files].sort();
}

/**
 * A size a person can read, in decimal units: the package's size is what
 * the build reports, so the reader can judge it without a calculator.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1000;
    unit++;
  } while (size >= 1000 && unit < units.length - 1);
  return `${size.toFixed(1)} ${units[unit]}`;
}
