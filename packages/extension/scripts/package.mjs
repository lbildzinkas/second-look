#!/usr/bin/env node
// Builds the one extension package (issue #32): the extension, the
// bundled engine and the WASM grammars together in one universal .vsix,
// with no per-OS builds (ADR 0005) and no publishing credentials — the
// package is written to a file and nothing is sent to any registry.
//
// Layout inside the package, the layout the extension already resolves
// against in a workspace install:
//
//   dist/index.js                                  the extension, bundled
//   node_modules/@second-look/engine/package.json  a manifest for resolution
//   node_modules/@second-look/engine/dist/main.js  the engine, bundled
//   node_modules/@second-look/engine/dist/pi-guard.js      Pi's guard, bundled
//   node_modules/@second-look/engine/dist/claude-guard.js  Claude Code's guard, bundled
//   node_modules/@vscode/tree-sitter-wasm/...      the WASM grammars
//   media/second-look.svg                          the Activity Bar icon
//
// The engine's own JavaScript dependencies are inlined into its bundle;
// only @vscode/tree-sitter-wasm stays a package, because its grammars
// are WASM files the engine resolves by name at review time.
//
// Run with `npm run package`, which builds first: the script reads the
// compiled engine output (dist/main.js and the guards the engine
// resolves next to itself) and the pure helpers from the extension's own
// compiled dist.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '@second-look/engine';
import {
  formatBytes,
  grammarFilesFor,
  stagedEngineManifest,
  stagedExtensionManifest,
  viewContainerIconFiles,
} from '../dist/packaging.js';

const require = createRequire(import.meta.url);
const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(extensionRoot, '..', '..');
const engineRoot = join(repoRoot, 'packages', 'engine');
/** The staged tree `vsce package` turns into the .vsix. */
const stage = join(extensionRoot, 'dist', 'package-stage');

/** Runs esbuild with the settings every bundle here shares. */
function bundle(options) {
  return build({
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'info',
    ...options,
  });
}

async function main() {
  const extensionManifest = JSON.parse(
    readFileSync(join(extensionRoot, 'package.json'), 'utf8'),
  );
  const engineManifest = JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8'));

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'dist'), { recursive: true });
  mkdirSync(join(stage, 'node_modules', '@second-look', 'engine', 'dist'), {
    recursive: true,
  });

  // The extension: one bundled file, with the editor's own API and the
  // staged tree-sitter runtime the only imports left external.
  await bundle({
    entryPoints: [join(extensionRoot, 'src', 'index.ts')],
    outfile: join(stage, 'dist', 'index.js'),
    external: ['vscode', '@vscode/tree-sitter-wasm'],
  });

  // The engine: bundled from its compiled output. The guards the engine
  // resolves next to itself — Pi's extension and Claude Code's hook — are
  // bundled as entry points of their own, so each ships as one
  // self-contained file with the core they share inlined.
  const stagedEngineDist = join(stage, 'node_modules', '@second-look', 'engine', 'dist');
  await bundle({
    entryPoints: [join(engineRoot, 'dist', 'main.js')],
    outfile: join(stagedEngineDist, 'main.js'),
    external: ['@vscode/tree-sitter-wasm'],
  });
  await bundle({
    entryPoints: [join(engineRoot, 'dist', 'pi-guard.js'), join(engineRoot, 'dist', 'claude-guard.js')],
    outdir: stagedEngineDist,
  });
  writeFileSync(
    join(stage, 'node_modules', '@second-look', 'engine', 'package.json'),
    `${JSON.stringify(stagedEngineManifest(engineManifest), undefined, 2)}\n`,
  );

  // The WASM grammars: the runtime's own files plus exactly the grammars
  // the engine's language list names.
  const treeSitterManifest = JSON.parse(
    readFileSync(require.resolve('@vscode/tree-sitter-wasm/package.json'), 'utf8'),
  );
  const treeSitterRoot = dirname(require.resolve('@vscode/tree-sitter-wasm/package.json'));
  const stagedTreeSitterWasm = join(stage, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
  mkdirSync(stagedTreeSitterWasm, { recursive: true });
  copyFileSync(
    join(treeSitterRoot, 'package.json'),
    join(stage, 'node_modules', '@vscode', 'tree-sitter-wasm', 'package.json'),
  );
  copyFileSync(
    join(treeSitterRoot, 'LICENSE'),
    join(stage, 'node_modules', '@vscode', 'tree-sitter-wasm', 'LICENSE'),
  );
  for (const file of grammarFilesFor(LANGUAGES)) {
    copyFileSync(join(treeSitterRoot, 'wasm', file), join(stagedTreeSitterWasm, file));
  }

  // The staged manifest declares exactly the two staged packages, at the
  // versions staged above: vsce's own npm dependency walk then carries
  // them into the file — and nothing else. No credential is read or
  // stored; the package is written to a file and never sent anywhere.
  writeFileSync(
    join(stage, 'package.json'),
    `${JSON.stringify(
      stagedExtensionManifest(extensionManifest, {
        '@second-look/engine': engineManifest.version,
        '@vscode/tree-sitter-wasm': treeSitterManifest.version,
      }),
      undefined,
      2,
    )}\n`,
  );
  // The icons the manifest's view containers name, at the same paths, so
  // the Activity Bar entry shows its icon once the package is installed.
  for (const icon of viewContainerIconFiles(extensionManifest)) {
    mkdirSync(dirname(join(stage, icon)), { recursive: true });
    copyFileSync(join(extensionRoot, icon), join(stage, icon));
  }
  copyFileSync(join(repoRoot, 'README.md'), join(stage, 'README.md'));
  copyFileSync(join(repoRoot, 'LICENSE'), join(stage, 'LICENSE'));

  const vsce = join(dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
  const vsixPath = join(
    extensionRoot,
    'dist',
    `${extensionManifest.name}-${extensionManifest.version}.vsix`,
  );
  const packaged = spawnSync(process.execPath, [vsce, 'package', '--out', vsixPath], {
    cwd: stage,
    stdio: 'inherit',
  });
  if (packaged.status !== 0) {
    throw new Error(`vsce package failed with exit code ${packaged.status}`);
  }

  const bytes = statSync(vsixPath).size;
  console.log(`packaged ${vsixPath} (${bytes} bytes, ${formatBytes(bytes)})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
