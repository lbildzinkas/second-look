import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  grammarFilesFor,
  stagedEngineManifest,
  stagedExtensionManifest,
  viewContainerIconFiles,
} from '../src/packaging.js';

describe('grammarFilesFor', () => {
  it('carries the runtime files plus exactly the named grammars, once each, sorted', () => {
    expect(
      grammarFilesFor([
        { grammar: 'tree-sitter-typescript.wasm' },
        { grammar: 'tree-sitter-python.wasm' },
        { grammar: 'tree-sitter-typescript.wasm' },
      ]),
    ).toEqual([
      'tree-sitter-python.wasm',
      'tree-sitter-typescript.wasm',
      'tree-sitter.js',
      'tree-sitter.wasm',
    ]);
  });

  it('keeps the runtime loadable even with no languages', () => {
    expect(grammarFilesFor([])).toEqual(['tree-sitter.js', 'tree-sitter.wasm']);
  });
});

describe('stagedEngineManifest', () => {
  it('keeps only the name, version and module type the resolution needs', () => {
    expect(
      stagedEngineManifest({
        name: '@second-look/engine',
        version: '0.1.0',
        bin: { 'second-look-engine': './dist/main.js' },
        dependencies: { '@octokit/rest': '^21.1.1' },
      }),
    ).toEqual({ name: '@second-look/engine', version: '0.1.0', type: 'module' });
  });
});

describe('stagedExtensionManifest', () => {
  it('keeps what the editor reads, drops the build wiring, and declares exactly the staged packages', () => {
    const staged = stagedExtensionManifest(
      {
        name: 'second-look-extension',
        displayName: 'Second Look',
        description: "The reviewer's companion.",
        version: '0.1.0',
        private: true,
        license: 'MIT',
        type: 'module',
        publisher: 'lbildzinkas',
        repository: { type: 'git', url: 'https://github.com/lbildzinkas/second-look' },
        engines: { node: '>=20', vscode: '^1.90.0' },
        categories: ['Other'],
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': './dist/index.js' },
        contributes: { commands: [] },
        scripts: { build: 'tsc -b', test: 'vitest run' },
        dependencies: { '@second-look/engine': '0.1.0' },
        devDependencies: { '@types/vscode': '^1.90.0' },
      },
      { '@second-look/engine': '0.1.0', '@vscode/tree-sitter-wasm': '0.3.1' },
    );
    expect(staged).toEqual({
      name: 'second-look-extension',
      displayName: 'Second Look',
      description: "The reviewer's companion.",
      version: '0.1.0',
      license: 'MIT',
      type: 'module',
      publisher: 'lbildzinkas',
      repository: { type: 'git', url: 'https://github.com/lbildzinkas/second-look' },
      engines: { node: '>=20', vscode: '^1.90.0' },
      categories: ['Other'],
      main: './dist/index.js',
      contributes: { commands: [] },
      dependencies: { '@second-look/engine': '0.1.0', '@vscode/tree-sitter-wasm': '0.3.1' },
    });
  });
});

describe('viewContainerIconFiles', () => {
  it("names every view container's icon once, across locations, sorted", () => {
    expect(
      viewContainerIconFiles({
        contributes: {
          viewsContainers: {
            activitybar: [
              { id: 'second-look', title: 'Second Look', icon: 'media/second-look.svg' },
              { id: 'other', title: 'Other', icon: 'media/other.svg' },
            ],
            panel: [{ id: 'again', title: 'Again', icon: 'media/second-look.svg' }],
          },
        },
      }),
    ).toEqual(['media/other.svg', 'media/second-look.svg']);
  });

  it('names nothing when the manifest contributes no view container', () => {
    expect(viewContainerIconFiles({ contributes: { commands: [] } })).toEqual([]);
    expect(viewContainerIconFiles({})).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('reads in decimal units', () => {
    expect(formatBytes(980)).toBe('980 B');
    expect(formatBytes(4_096)).toBe('4.1 KB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
  });
});
