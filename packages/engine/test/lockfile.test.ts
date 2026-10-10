import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LockfileFormat, WorkspaceMember } from '../src/lockfile.js';
import {
  confirmLockfileChange,
  confirmLockfileNoise,
  lockfileFormatFor,
  lockfileManifests,
} from '../src/lockfile.js';
import type { LockfileSide } from '../src/lockfile.js';
import type { Part } from '../src/protocol.js';

function format(name: string): LockfileFormat {
  const found = lockfileFormatFor(name);
  if (found === undefined) throw new Error(`no format for ${name}`);
  return found;
}

/** Both sides of one lock file's story, from raw texts. */
function side(
  lock: string | null,
  manifests: readonly string[] = [],
  members: readonly WorkspaceMember[] = [],
): LockfileSide {
  return { lock, manifests, members };
}

function confirmed(
  format: LockfileFormat,
  oldSide: LockfileSide,
  newSide: LockfileSide,
): ReturnType<typeof confirmLockfileChange> {
  return confirmLockfileChange(format, format.name, oldSide, newSide);
}

/** One side's copy of the repository, as the archive reader materializes it. */
function copyWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'second-look-copies-'));
  for (const [relative, text] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

/** A part the lock file checks read: only its path and text-ness matter. */
function lockfilePart(path: string): Part {
  return {
    path,
    changeKind: 'modification',
    isBinary: false,
    oldMissingFinalNewline: false,
    newMissingFinalNewline: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    syntax: { formattingOnly: { status: 'not-checked', reason: '' }, checksNotRun: [] },
  };
}


/** Runs the copy-driven check on one lock file, both copies built from these files, and cleans up. */
async function assessCopies(
  lockPath: string,
  baseFiles: Record<string, string>,
  headFiles: Record<string, string>,
): Promise<{ state: string; rule: string; blindSpot: string }> {
  const base = copyWith(baseFiles);
  const head = copyWith(headFiles);
  try {
    const assessment = (await confirmLockfileNoise([lockfilePart(lockPath)], { base, head })).get(lockPath);
    if (assessment === undefined || assessment.label === 'none') {
      throw new Error(`expected a labelled lockfile assessment for ${lockPath}`);
    }
    return { state: assessment.state, rule: assessment.rule, blindSpot: assessment.blindSpot };
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(head, { recursive: true, force: true });
  }
}

describe('package-lock.json', () => {
  const manifest = (leftPad: string): string =>
    JSON.stringify({
      name: 'app',
      dependencies: { 'left-pad': leftPad, mkdirp: '^1.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    });
  const lock = (leftPadVersion: string, resolved: string, innerPkg: boolean): string =>
    JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: { 'left-pad': `^${leftPadVersion}` } },
        ...(innerPkg
          ? {
              'node_modules/inner-pkg': {
                version: '1.0.2',
                resolved: 'https://registry.npmjs.org/inner-pkg/-/inner-pkg-1.0.2.tgz',
              },
            }
          : {}),
        'node_modules/left-pad': {
          version: leftPadVersion,
          resolved,
          ...(innerPkg ? { dependencies: { 'inner-pkg': '^1.0.0' } } : {}),
        },
        'node_modules/mkdirp': { version: '1.0.4' },
        'node_modules/typescript': { version: '5.4.5', dev: true },
      },
    });

  it('confirms a bump whose changed entries the manifest closure covers', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(lock('1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', false), [
        manifest('^1.3.0'),
      ]),
      side(lock('2.0.0', 'https://registry.npmjs.org/left-pad/-/left-pad-2.0.0.tgz', true), [
        manifest('^2.0.0'),
      ]),
    );
    expect(check.outcome).toBe('confirmed');
    // A confirmed label states its blind spots (issue 23).
    expect(check.blindSpot).toContain('not re-checked against the registry');
    expect(check.blindSpot).toContain('Parse-only');
  });

  it('stays claimed and names an entry the manifest change does not explain', () => {
    const withHandEdit = JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/mkdirp': { version: '1.0.4' },
        'node_modules/typescript': { version: '5.4.5', dev: true },
        'node_modules/evil-pkg': { version: '9.9.9' },
      },
    });
    const check = confirmed(
      format('package-lock.json'),
      side(lock('1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', false), [
        manifest('^1.3.0'),
      ]),
      side(withHandEdit, [manifest('^1.3.0')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('evil-pkg@9.9.9');
  });

  it('names an entry whose content changed at the same version', () => {
    const tampered = JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        'node_modules/left-pad': {
          version: '1.3.0',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
          integrity: 'sha512-tampered',
        },
        'node_modules/mkdirp': { version: '1.0.4' },
        'node_modules/typescript': { version: '5.4.5', dev: true },
      },
    });
    const check = confirmed(
      format('package-lock.json'),
      side(lock('1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', false), [
        manifest('^1.3.0'),
      ]),
      side(tampered, [manifest('^1.3.0')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('left-pad@1.3.0 (content changed)');
  });

  it('stays claimed and names a root-entry change the manifest does not explain', () => {
    const rootEdited = JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: { 'left-pad': '^9.9.9' } },
        'node_modules/left-pad': {
          version: '1.3.0',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        },
        'node_modules/mkdirp': { version: '1.0.4' },
        'node_modules/typescript': { version: '5.4.5', dev: true },
      },
    });
    const check = confirmed(
      format('package-lock.json'),
      side(lock('1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', false), [
        manifest('^1.3.0'),
      ]),
      side(rootEdited, [manifest('^1.3.0')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the root entry (content changed)');
  });

  it('stays claimed and names a workspace entry the manifest does not explain', () => {
    const withWorkspace = JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: { 'left-pad': '^1.3.0' } },
        'packages/web': { name: 'web', version: '1.0.0', dependencies: {} },
        'node_modules/left-pad': {
          version: '1.3.0',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        },
        'node_modules/mkdirp': { version: '1.0.4' },
        'node_modules/typescript': { version: '5.4.5', dev: true },
      },
    });
    const check = confirmed(
      format('package-lock.json'),
      side(lock('1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', false), [
        manifest('^1.3.0'),
      ]),
      side(withWorkspace, [manifest('^1.3.0')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the packages/web entry (added)');
  });

  it('stays claimed and names a legacy mirror change the manifest does not explain', () => {
    const lockV2 = (mirrorVersion: string): string =>
      JSON.stringify({
        name: 'app',
        lockfileVersion: 2,
        packages: {
          '': { name: 'app', dependencies: { 'left-pad': '^1.3.0' } },
          'node_modules/left-pad': {
            version: '1.3.0',
            resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
          },
          'node_modules/mkdirp': { version: '1.0.4' },
        },
        dependencies: {
          'left-pad': {
            version: mirrorVersion,
            resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
            integrity: 'sha512-x',
          },
          mkdirp: { version: '1.0.4', resolved: 'y', integrity: 'z' },
        },
      });
    const check = confirmed(
      format('package-lock.json'),
      side(lockV2('1.3.0'), [manifest('^1.3.0')]),
      side(lockV2('9.9.9'), [manifest('^1.3.0')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('left-pad@9.9.9');
    expect(check.blindSpot).toContain('left-pad@1.3.0 (content changed)');
  });

  it('confirms a bump that regenerates the legacy mirror with it', () => {
    const regenerated = (leftPadVersion: string): string =>
      JSON.stringify({
        name: 'app',
        lockfileVersion: 2,
        packages: {
          '': { name: 'app', dependencies: { 'left-pad': `^${leftPadVersion}` } },
          'node_modules/left-pad': {
            version: leftPadVersion,
            resolved: `https://registry.npmjs.org/left-pad/-/left-pad-${leftPadVersion}.tgz`,
          },
          'node_modules/mkdirp': { version: '1.0.4' },
        },
        dependencies: {
          'left-pad': {
            version: leftPadVersion,
            resolved: `https://registry.npmjs.org/left-pad/-/left-pad-${leftPadVersion}.tgz`,
            integrity: 'sha512-x',
          },
          mkdirp: { version: '1.0.4', resolved: 'y', integrity: 'z' },
        },
      });
    const check = confirmed(
      format('package-lock.json'),
      side(regenerated('1.3.0'), [manifest('^1.3.0')]),
      side(regenerated('2.0.0'), [manifest('^2.0.0')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  // The mirror npm 7/8 writes beside `packages`, with a workspace member:
  // its own entry in the mirror carries `file:` naming its folder, and
  // its dependencies under `requires`.
  const memberMirrorLock = (
    isEvenSpec: string,
    isEvenVersion: string,
    mirror: { withWeb?: boolean; smuggled?: boolean; smuggledRequire?: boolean } = {},
  ): string =>
    JSON.stringify({
      name: 'app',
      lockfileVersion: 2,
      packages: {
        '': { name: 'app', workspaces: ['packages/*'], dependencies: { 'left-pad': '^1.3.0' } },
        ...(mirror.withWeb === false
          ? {}
          : {
              'packages/web': { name: 'web', version: '1.0.0', dependencies: { 'is-even': isEvenSpec } },
              'node_modules/web': { resolved: 'packages/web', link: true },
            }),
        'node_modules/is-even': { version: isEvenVersion },
        'node_modules/left-pad': { version: '1.3.0' },
      },
      dependencies: {
        'is-even': { version: isEvenVersion },
        'left-pad': { version: '1.3.0' },
        ...(mirror.withWeb === false
          ? {}
          : {
              web: {
                version: 'file:packages/web',
                requires: {
                  'is-even': isEvenSpec,
                  ...(mirror.smuggledRequire === true ? { 'evil-pkg': '*' } : {}),
                },
              },
            }),
        ...(mirror.smuggled === true
          ? {
              'evil-pkg': {
                version: '6.6.6',
                resolved: 'https://evil.example/evil-pkg/-/evil-pkg-6.6.6.tgz',
                integrity: 'sha512-evil',
              },
            }
          : {}),
      },
    });
  const evenWeb = (isEvenSpec: string): WorkspaceMember => ({
    dir: 'packages/web',
    manifest: JSON.stringify({
      name: 'web',
      version: '1.0.0',
      dependencies: { 'is-even': isEvenSpec },
    }),
  });

  it('confirms a member bump that regenerates the legacy mirror with it', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberMirrorLock('^1.0.0', '1.0.0'), [manifest('^1.3.0')], [evenWeb('^1.0.0')]),
      side(memberMirrorLock('^2.0.0', '2.0.0'), [manifest('^1.3.0')], [evenWeb('^2.0.0')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('confirms adding a workspace member whose legacy mirror entry arrives with it', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberMirrorLock('^1.0.0', '1.0.0', { withWeb: false }), [manifest('^1.3.0')]),
      side(memberMirrorLock('^1.0.0', '1.0.0'), [manifest('^1.3.0')], [evenWeb('^1.0.0')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('stays claimed and names a mirror-only entry smuggled in beside a member bump', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberMirrorLock('^1.0.0', '1.0.0'), [manifest('^1.3.0')], [evenWeb('^1.0.0')]),
      side(
        memberMirrorLock('^2.0.0', '2.0.0', { smuggled: true }),
        [manifest('^1.3.0')],
        [evenWeb('^2.0.0')],
      ),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('evil-pkg@6.6.6');
    expect(check.blindSpot).not.toContain('is-even');
    expect(check.blindSpot).not.toContain('packages/web');
  });

  it("stays claimed and names a dependency smuggled into the member's mirror entry", () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberMirrorLock('^1.0.0', '1.0.0'), [manifest('^1.3.0')], [evenWeb('^1.0.0')]),
      side(
        memberMirrorLock('^2.0.0', '2.0.0', { smuggledRequire: true }),
        [manifest('^1.3.0')],
        [evenWeb('^2.0.0')],
      ),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the packages/web entry (content changed)');
  });

  const memberLock = (
    web: Record<string, unknown>,
    leftPadVersion: string,
    leftPadSpec: string,
  ): string =>
    JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: { 'left-pad': leftPadSpec } },
        'packages/web': web,
        'node_modules/web': { resolved: 'packages/web', link: true },
        'node_modules/left-pad': { version: leftPadVersion },
      },
    });

  const webManifest = (version: string): string => JSON.stringify({ name: 'web', version });
  const web = (version: string): WorkspaceMember => ({
    dir: 'packages/web',
    manifest: webManifest(version),
  });

  it('stays claimed and names a member record rewritten as a registry tarball', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberLock({ name: 'web', version: '1.0.0' }, '1.3.0', '^1.3.0'), [manifest('^1.3.0')], [web('1.0.0')]),
      side(
        memberLock(
          {
            name: 'web',
            version: '1.1.0',
            resolved: 'https://evil.example/web/-/web-1.1.0.tgz',
            integrity: 'sha512-evil',
          },
          '2.0.0',
          '^2.0.0',
        ),
        [manifest('^2.0.0')],
        [web('1.1.0')],
      ),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the packages/web entry (content changed)');
  });

  it('confirms a member bump whose package.json this pull request also changes', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberLock({ name: 'web', version: '1.0.0' }, '1.3.0', '^1.3.0'), [manifest('^1.3.0')], [web('1.0.0')]),
      side(memberLock({ name: 'web', version: '1.1.0' }, '1.3.0', '^1.3.0'), [manifest('^1.3.0')], [web('1.1.0')]),
    );
    expect(check.outcome).toBe('confirmed');
    expect(check.blindSpot).toContain('workspace declaration names');
  });

  it('stays claimed and names a member record change without its package.json in the pull request', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberLock({ name: 'web', version: '1.0.0' }, '1.3.0', '^1.3.0'), [manifest('^1.3.0')], [web('1.0.0')]),
      side(memberLock({ name: 'web', version: '9.9.9' }, '2.0.0', '^2.0.0'), [manifest('^2.0.0')], [web('1.0.0')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the packages/web entry (content changed)');
  });

  it('stays claimed and names a member record the workspace does not declare', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberLock({ name: 'web', version: '1.0.0' }, '1.3.0', '^1.3.0'), [manifest('^1.3.0')]),
      side(memberLock({ name: 'web', version: '1.1.0' }, '1.3.0', '^1.3.0'), [manifest('^1.3.0')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the packages/web entry (content changed)');
  });

  it('stays claimed and names a member record naming a dependency its package.json does not declare', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(memberLock({ name: 'web', version: '1.0.0' }, '1.3.0', '^1.3.0'), [manifest('^1.3.0')], [web('1.0.0')]),
      side(
        memberLock({ name: 'web', version: '1.1.0', dependencies: { 'left-pad': '*' } }, '1.3.0', '^1.3.0'),
        [manifest('^1.3.0')],
        [web('1.1.0')],
      ),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the packages/web entry (content changed)');
  });

  it('confirms a root metadata edit with no dependency change', () => {
    const rootManifest = (license: string): string =>
      JSON.stringify({ name: 'app', license, dependencies: { 'left-pad': '^1.3.0' } });
    const rootLock = (license: string): string =>
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', license, dependencies: { 'left-pad': '^1.3.0' } },
          'node_modules/left-pad': { version: '1.3.0' },
        },
      });
    const check = confirmed(
      format('package-lock.json'),
      side(rootLock('ISC'), [rootManifest('ISC')]),
      side(rootLock('MIT'), [rootManifest('MIT')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('stays claimed and names a root entry naming a dependency the package.json does not declare', () => {
    const rootManifest = (license: string): string =>
      JSON.stringify({ name: 'app', license, dependencies: { 'left-pad': '^1.3.0' } });
    const rootLock = (license: string, extra: Record<string, string>): string =>
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', license, dependencies: { 'left-pad': '^1.3.0', ...extra } },
          'node_modules/left-pad': { version: '1.3.0' },
        },
      });
    const check = confirmed(
      format('package-lock.json'),
      side(rootLock('ISC', {}), [rootManifest('ISC')]),
      side(rootLock('MIT', { 'evil-pkg': '*' }), [rootManifest('MIT')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the root entry (content changed)');
  });

  it('runs no check when adversarial nesting overflows the reader', () => {
    // Built by concatenation: JSON.stringify of a structure this deep overflows
    // the stack itself, before the reader under test ever runs.
    const deep =
      `{"lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"1.3.0","pad":` +
      `${'['.repeat(50_000)}${']'.repeat(50_000)}}}}`;
    const check = confirmed(
      format('package-lock.json'),
      side(deep, [manifest('^1.3.0')]),
      side(deep, [manifest('^1.3.0')]),
    );
    expect(check.outcome).toBe('no check');
    expect(check.blindSpot).toContain('no check for this lockfile');
  });

  it('reads the v1 nested-entries form too', () => {
    const check = confirmed(
      format('package-lock.json'),
      side(
        JSON.stringify({
          lockfileVersion: 1,
          dependencies: { 'left-pad': { version: '1.3.0', resolved: 'x', integrity: 'y' } },
        }),
        [manifest('^1.3.0')],
      ),
      side(
        JSON.stringify({
          lockfileVersion: 1,
          dependencies: {
            'left-pad': {
              version: '2.0.0',
              resolved: 'z',
              integrity: 'w',
              requires: { 'inner-pkg': '^1.0.0' },
            },
            'inner-pkg': { version: '1.0.0', requires: {} },
          },
        }),
        [manifest('^2.0.0')],
      ),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('runs no check when the lock file does not parse', () => {
    const check = confirmed(
      format('package-lock.json'),
      side('{"lockfileVersion": 3, "packages": {', [manifest('^1.0.0')]),
      side('{}', [manifest('^1.0.0')]),
    );
    expect(check.outcome).toBe('no check');
    expect(check.blindSpot).toContain('no check for this lockfile');
  });

  it('confirms a bump an overrides change explains', () => {
    const overrideManifest = (bar: string): string =>
      JSON.stringify({
        name: 'app',
        dependencies: { 'left-pad': '^1.3.0' },
        overrides: { bar },
      });
    const overrideLock = (barVersion: string): string =>
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', dependencies: { 'left-pad': '^1.3.0' } },
          'node_modules/left-pad': { version: '1.3.0' },
          'node_modules/bar': { version: barVersion },
        },
      });
    const check = confirmed(
      format('package-lock.json'),
      side(overrideLock('2.0.0'), [overrideManifest('2.0.0')]),
      side(overrideLock('2.1.0'), [overrideManifest('2.1.0')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('confirms a bump a scoped override nested in a table explains', () => {
    const scopedManifest = (bar: string): string =>
      JSON.stringify({
        name: 'app',
        dependencies: { 'left-pad': '^1.3.0' },
        overrides: { 'left-pad': { bar } },
      });
    const scopedLock = (barVersion: string): string =>
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', dependencies: { 'left-pad': '^1.3.0' } },
          'node_modules/left-pad': { version: '1.3.0' },
          'node_modules/bar': { version: barVersion },
        },
      });
    const check = confirmed(
      format('package-lock.json'),
      side(scopedLock('2.0.0'), [scopedManifest('2.0.0')]),
      side(scopedLock('2.1.0'), [scopedManifest('2.1.0')]),
    );
    expect(check.outcome).toBe('confirmed');
  });
});

describe('uv.lock', () => {
  const pyproject = (anyio: string): string => `
[project]
name = "app"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "anyio${anyio}",
]
`;
  const lock = (anyioVersion: string, extra: string): string => `
version = 1
requires-python = ">=3.11"

[[package]]
name = "anyio"
version = "${anyioVersion}"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "idna" },
    { name = "sniffio" },
]

[[package]]
name = "idna"
version = "3.7"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "sniffio"
version = "1.3.1"
source = { registry = "https://pypi.org/simple" }
${extra}
[manifest]
requirements-hash = "deadbeef"
`;

  it('confirms a bump, following the recorded edges by PEP 503 name', () => {
    const check = confirmed(
      format('uv.lock'),
      side(lock('4.3.0', ''), [pyproject('>=4.3')]),
      side(lock('4.4.0', ''), [pyproject('>=4.4')]),
    );
    expect(check.outcome).toBe('confirmed');
    expect(check.blindSpot).toContain('not re-checked');
  });

  it('stays claimed and names an entry no manifest change explains', () => {
    const check = confirmed(
      format('uv.lock'),
      side(lock('4.3.0', ''), [pyproject('>=4.3')]),
      side(lock('4.3.0', '\n[[package]]\nname = "smuggled"\nversion = "1.0"\n'), [
        pyproject('>=4.3'),
      ]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('smuggled@1.0');
  });

  it('normalizes manifest names the way the lock file records them', () => {
    const check = confirmed(
      format('uv.lock'),
      side(lock('4.3.0', ''), ['[project]\nname = "app"\ndependencies = ["AnyIO>=4.3"]\n']),
      side(lock('4.4.0', ''), ['[project]\nname = "app"\ndependencies = ["ANYIO>=4.4"]\n']),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('runs no check when adversarial nesting overflows the reader', () => {
    const deep = `[[package]]\nname = "anyio"\nversion = "4.4.0"\ndependencies = [${'['.repeat(10_000)}${']'.repeat(10_000)}]\n`;
    const check = confirmed(
      format('uv.lock'),
      side(deep, [pyproject('>=4.3')]),
      side(deep, [pyproject('>=4.3')]),
    );
    expect(check.outcome).toBe('no check');
    expect(check.blindSpot).toContain('no check for this lockfile');
  });

  it('runs no check when a manifest escape is outside Unicode', () => {
    const broken = '[project]\nname = "app"\ndescription = "\\U00110000"\n';
    const check = confirmed(
      format('uv.lock'),
      side(lock('4.3.0', ''), [broken]),
      side(lock('4.4.0', ''), [broken]),
    );
    expect(check.outcome).toBe('no check');
    expect(check.blindSpot).toContain('pyproject.toml did not parse');
  });

  const projectLock = (anyioVersion: string, specifier: string): string => `
version = 1

[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }

[package.metadata]
requires-dist = [
    { name = "anyio", specifier = "${specifier}" },
]

[[package]]
name = "anyio"
version = "${anyioVersion}"
source = { registry = "https://pypi.org/simple" }
`;

  it('confirms a bump when the lock records the project itself', () => {
    const check = confirmed(
      format('uv.lock'),
      side(projectLock('4.3.0', '>=4.3'), [pyproject('>=4.3')]),
      side(projectLock('4.4.0', '>=4.4'), [pyproject('>=4.4')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('stays claimed and names a hand-edited project entry', () => {
    const check = confirmed(
      format('uv.lock'),
      side(projectLock('4.3.0', '>=4.3'), [pyproject('>=4.3')]),
      side(projectLock('4.3.0', '>=9.9.9'), [pyproject('>=4.3')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the app entry (content changed)');
  });

  it('stays claimed and names a hand-edited workspace member', () => {
    const workspaceLock = (specifier: string, anyioVersion: string, tampered: boolean): string => `
version = 1

[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }

[package.metadata]
requires-dist = [
    { name = "anyio", specifier = "${specifier}" },
]

[[package]]
name = "member-a"
version = "0.1.0"
source = { editable = "packages/member-a" }
dependencies = [
    { name = "anyio" },${tampered ? '\n    { name = "smuggled" },' : ''}
]

[[package]]
name = "anyio"
version = "${anyioVersion}"
source = { registry = "https://pypi.org/simple" }
`;
    const check = confirmed(
      format('uv.lock'),
      side(workspaceLock('>=4.3', '4.3.0', false), [pyproject('>=4.3')]),
      side(workspaceLock('>=4.4', '4.4.0', true), [pyproject('>=4.4')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('member-a@0.1.0 (content changed)');
  });

  it('confirms a bump when the project records itself as editable', () => {
    const editableLock = (specifier: string, anyioVersion: string): string => `
version = 1

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }

[package.metadata]
requires-dist = [
    { name = "anyio", specifier = "${specifier}" },
]

[[package]]
name = "anyio"
version = "${anyioVersion}"
source = { registry = "https://pypi.org/simple" }
`;
    const check = confirmed(
      format('uv.lock'),
      side(editableLock('>=4.3', '4.3.0'), [pyproject('>=4.3')]),
      side(editableLock('>=4.4', '4.4.0'), [pyproject('>=4.4')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('parses a lock whose dev dependencies are grouped by name', () => {
    const groupedLock = (specifier: string, anyioVersion: string): string => `
version = 1

[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }

[package.dev-dependencies]
dev = [
    { name = "pytest" },
]

[package.metadata]
requires-dist = [
    { name = "anyio", specifier = "${specifier}" },
]

[[package]]
name = "anyio"
version = "${anyioVersion}"
source = { registry = "https://pypi.org/simple" }
`;
    const withDev = (anyio: string): string => `${pyproject(anyio)}\n[dependency-groups]\ndev = ["pytest"]\n`;
    const check = confirmed(
      format('uv.lock'),
      side(groupedLock('>=4.3', '4.3.0'), [withDev('>=4.3')]),
      side(groupedLock('>=4.4', '4.4.0'), [withDev('>=4.4')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  const devManifest = (extra: string): string => `
[project]
name = "app"
dependencies = ["anyio>=4.3"]
${extra}`;
  const devLock = (withPytest: boolean): string => `
version = 1

[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }

[[package]]
name = "anyio"
version = "4.3.0"
source = { registry = "https://pypi.org/simple" }
${withPytest ? '\n[[package]]\nname = "pytest"\nversion = "8.3.4"\nsource = { registry = "https://pypi.org/simple" }\n' : ''}`;

  it('confirms a dev dependency added through a dependency group', () => {
    const check = confirmed(
      format('uv.lock'),
      side(devLock(false), [devManifest('')]),
      side(devLock(true), [devManifest('[dependency-groups]\ndev = ["pytest>=8"]\n')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('confirms a dev dependency added through legacy tool.uv dev-dependencies', () => {
    const check = confirmed(
      format('uv.lock'),
      side(devLock(false), [devManifest('')]),
      side(devLock(true), [devManifest('[tool.uv]\ndev-dependencies = ["pytest>=8"]\n')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('reads dependency groups that compose others with include-group', () => {
    const check = confirmed(
      format('uv.lock'),
      side(devLock(false), [devManifest('')]),
      side(devLock(true), [
        devManifest('[dependency-groups]\ndev = ["pytest>=8"]\nall = [{include-group = "dev"}]\n'),
      ]),
    );
    expect(check.outcome).toBe('confirmed');
  });
});

describe('poetry.lock', () => {
  const pyproject = (httpx: string): string => `
[tool.poetry]
name = "app"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
httpx = "${httpx}"
`;
  const lockV2 = (httpxVersion: string): string => `
[[package]]
name = "certifi"
version = "2024.2.2"

[[package]]
name = "httpx"
version = "${httpxVersion}"

[package.dependencies]
certifi = "*"

[metadata]
lock-version = "2.0"
content-hash = "abc"
`;
  const lockV21 = (httpxVersion: string): string => `
[[package]]
name = "httpx"
version = "${httpxVersion}"
dependencies = [
    { name = "certifi" },
]

[[package]]
name = "certifi"
version = "2024.2.2"
`;

  it('confirms a bump in the table-keyed lock version', () => {
    const check = confirmed(
      format('poetry.lock'),
      side(lockV2('0.27.0'), [pyproject('>=0.24')]),
      side(lockV2('0.27.2'), [pyproject('>=0.27')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('confirms a bump in the array-of-tables lock version', () => {
    const check = confirmed(
      format('poetry.lock'),
      side(lockV21('0.27.0'), [pyproject('>=0.24')]),
      side(lockV21('0.27.2'), [pyproject('>=0.27')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('stays claimed and names a hand-edited entry', () => {
    const check = confirmed(
      format('poetry.lock'),
      side(lockV2('0.27.0'), [pyproject('>=0.24')]),
      side(lockV2('99.9.9'), [pyproject('>=0.24')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('httpx 0.27.0 → 99.9.9');
  });

  it('reads dependency groups too, not only the main table', () => {
    const manifest = (pytest: string): string => `
[tool.poetry.dependencies]
python = "^3.11"

[tool.poetry.group.dev.dependencies]
pytest = "${pytest}"
`;
    const lock = (pytestVersion: string): string => `
[[package]]
name = "pytest"
version = "${pytestVersion}"
`;
    const check = confirmed(
      format('poetry.lock'),
      side(lock('8.0.0'), [manifest('^7.0')]),
      side(lock('8.2.0'), [manifest('^8.0')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('confirms a bump declared in the PEP 621 [project] table', () => {
    const manifest = (httpx: string): string => `
[project]
name = "app"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["httpx${httpx}"]
`;
    const check = confirmed(
      format('poetry.lock'),
      side(lockV2('0.27.0'), [manifest('>=0.24')]),
      side(lockV2('0.27.2'), [manifest('>=0.27')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('confirms a dev dependency added through a PEP 735 dependency group', () => {
    const manifest = (extra: string): string => `
[project]
name = "app"
dependencies = []
${extra}`;
    const lock = (withPytest: boolean): string => `
[[package]]
name = "certifi"
version = "2024.2.2"
${withPytest ? '\n[[package]]\nname = "pytest"\nversion = "8.2.0"\n' : ''}`;
    const check = confirmed(
      format('poetry.lock'),
      side(lock(false), [manifest('')]),
      side(lock(true), [manifest('[dependency-groups]\ndev = ["pytest>=8"]\n')]),
    );
    expect(check.outcome).toBe('confirmed');
  });
});

describe('Cargo.lock', () => {
  const manifest = (serde: string): string => `
[package]
name = "app"
version = "0.1.0"

[dependencies]
serde = { version = "${serde}", features = ["derive"] }

[target.'cfg(windows)'.dependencies]
winapi = "0.3"
`;
  const lock = (serdeVersion: string, withDerive: boolean): string => `
# This file is automatically @generated by Cargo.
version = 3

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde",
]

[[package]]
name = "serde"
version = "${serdeVersion}"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "3fb1c873e1b9b056a4dc4c0c198b24c3ffa059243875552b2bd0933b1aee4f2"
dependencies = [
 "serde_derive",
]
${withDerive ? '' : ''}
[[package]]
name = "serde_derive"
version = "1.0.197"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "winapi"
version = "0.3.9"
`;

  it('confirms a bump whose transitive entries follow', () => {
    const check = confirmed(
      format('Cargo.lock'),
      side(lock('1.0.197', false), [manifest('1.0')]),
      side(lock('1.0.204', true), [manifest('1.0.204')]),
    );
    expect(check.outcome).toBe('confirmed');
    expect(check.blindSpot).toContain('checksums are not re-checked');
  });

  it('stays claimed and names a crate the manifest change does not explain', () => {
    const smuggled = lock('1.0.197', false).replace(
      '[[package]]\nname = "winapi"\nversion = "0.3.9"\n',
      '[[package]]\nname = "winapi"\nversion = "99.0.0"\n',
    );
    const check = confirmed(
      format('Cargo.lock'),
      side(lock('1.0.197', false), [manifest('1.0')]),
      side(smuggled, [manifest('1.0')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('winapi 0.3.9 → 99.0.0');
  });

  it('normalizes crate names the way the lock file records them', () => {
    const toml = (serde: string, derive: string): string => `
[package]
name = "app"
version = "0.1.0"

[dependencies]
serde = "${serde}"
serde_derive = "${derive}"
`;
    const lockFile = (serdeVersion: string, deriveVersion: string): string => `
# This file is automatically @generated by Cargo.
version = 3

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde",
]

[[package]]
name = "serde"
version = "${serdeVersion}"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = [
 "serde_derive",
]

[[package]]
name = "serde_derive"
version = "${deriveVersion}"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    const check = confirmed(
      format('Cargo.lock'),
      side(lockFile('1.0.197', '1.0.197'), [toml('1.0', '1.0.197')]),
      side(lockFile('1.0.204', '1.0.204'), [toml('1.0.204', '1.0.204')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('registers a renamed dependency under the name the lock file records', () => {
    const toml = (version: string): string => `
[package]
name = "app"
version = "0.1.0"

[dependencies]
pretty-cli = { version = "${version}", package = "clap" }
`;
    const lockFile = (clapVersion: string): string => `
# This file is automatically @generated by Cargo.
version = 3

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "clap",
]

[[package]]
name = "clap"
version = "${clapVersion}"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    const check = confirmed(
      format('Cargo.lock'),
      side(lockFile('4.4.0'), [toml('4')]),
      side(lockFile('4.5.0'), [toml('4.5')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('confirms a dependency add that grows the root package entry', () => {
    const tomlAdd = (withWinapi: boolean): string => `
[package]
name = "app"
version = "0.1.0"

[dependencies]
serde = "1.0.204"
${withWinapi ? 'winapi = "0.3"\n' : ''}`;
    const lockAdd = (withWinapi: boolean): string => `
# This file is automatically @generated by Cargo.
version = 3

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde",
${withWinapi ? ' "winapi",\n' : ''}]

[[package]]
name = "serde"
version = "1.0.204"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "winapi"
version = "0.3.9"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    const check = confirmed(
      format('Cargo.lock'),
      side(lockAdd(false), [tomlAdd(false)]),
      side(lockAdd(true), [tomlAdd(true)]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('stays claimed and names a hand-edited path dependency', () => {
    const tomlPath = `
[package]
name = "app"
version = "0.1.0"

[dependencies]
local-crate = { path = "../local-crate" }
`;
    const lockPath = (version: string): string => `
[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "local-crate",
]

[[package]]
name = "local-crate"
version = "${version}"
`;
    const check = confirmed(
      format('Cargo.lock'),
      side(lockPath('1.0.0'), [tomlPath]),
      side(lockPath('9.9.9'), [tomlPath]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('local-crate 1.0.0 → 9.9.9');
  });
});

describe('packages.lock.json', () => {
  const project = (json: string): string => `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="${json}" />
  </ItemGroup>
</Project>
`;
  const lock = (json: string, csharp: string): string => `
{
  "version": 1,
  "dependencies": {
    "net8.0": {
      "Newtonsoft.Json": {
        "type": "Direct",
        "requested": "[${json}, 14.0.0)",
        "resolved": "${json}",
        "contentHash": "HrC5BXdl00IP9zeV+0Z848QWPAoCr9P3bDEZguI=",
        "dependencies": {
          "Microsoft.CSharp": "4.7.0"
        }
      },
      "Microsoft.CSharp": {
        "type": "Transitive",
        "resolved": "${csharp}",
        "contentHash": "bgH3fHg7XpRoWg5RtL6aBmV5MkZ1s+1HgS8wT5kG0="
      }
    }
  }
}
`;

  it('stays claimed when only a transitive entry changed and no manifest change exists', () => {
    const check = confirmed(
      format('packages.lock.json'),
      side(lock('13.0.3', '4.7.0'), [project('13.0.3')]),
      side(lock('13.0.3', '4.7.1'), [project('13.0.3')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('microsoft.csharp 4.7.0 → 4.7.1');
  });

  it('confirms a transitive bump reached through the recorded dependency edges', () => {
    const check = confirmed(
      format('packages.lock.json'),
      side(lock('13.0.3', '4.7.0'), [project('13.0.3')]),
      side(lock('13.0.1', '4.7.1'), [project('13.0.1')]),
    );
    expect(check.outcome).toBe('confirmed');
    expect(check.blindSpot).toContain('Parse-only');
    expect(check.blindSpot).toContain('content hashes are not re-checked');
  });

  it('stays claimed and names a smuggled transitive while a manifest dependency changed', () => {
    const smuggled = JSON.parse(lock('13.0.1', '4.7.0')) as {
      dependencies: Record<string, Record<string, unknown>>;
    };
    smuggled.dependencies['net8.0']!['Serilog'] = { type: 'Transitive', resolved: '4.0.2' };
    const check = confirmed(
      format('packages.lock.json'),
      side(lock('13.0.3', '4.7.0'), [project('13.0.3')]),
      side(JSON.stringify(smuggled), [project('13.0.1')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('serilog@4.0.2');
  });

  it('stays claimed when one framework copy of a duplicate entry is hand-edited', () => {
    const multi = (y8: string, json: string): string => `
{
  "version": 1,
  "dependencies": {
    "net8.0": {
      "Newtonsoft.Json": {
        "type": "Direct",
        "requested": "[${json}, 14.0.0)",
        "resolved": "${json}",
        "contentHash": "direct-hash"
      },
      "Y": {
        "type": "Transitive",
        "resolved": "1.0.0",
        "contentHash": "${y8}"
      }
    },
    "netstandard2.0": {
      "Newtonsoft.Json": {
        "type": "Direct",
        "requested": "[${json}, 14.0.0)",
        "resolved": "${json}",
        "contentHash": "direct-hash"
      },
      "Y": {
        "type": "Transitive",
        "resolved": "1.0.0",
        "contentHash": "y-netstandard"
      }
    }
  }
}
`;
    const check = confirmed(
      format('packages.lock.json'),
      side(multi('y-net8', '13.0.3'), [project('13.0.3')]),
      side(multi('y-tampered', '13.0.1'), [project('13.0.1')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('y@1.0.0 (content changed)');
  });

  it('treats reordered frameworks as no change to duplicate entries', () => {
    const frameworks = (y8: string): Record<string, unknown> => ({
      'net8.0': { Y: { type: 'Transitive', resolved: '1.0.0', contentHash: y8 } },
      'netstandard2.0': { Y: { type: 'Transitive', resolved: '1.0.0', contentHash: 'y-netstandard' } },
    });
    const before = JSON.stringify({ version: 1, dependencies: frameworks('y-net8') });
    const swapped = frameworks('y-net8');
    const after = JSON.stringify({
      version: 1,
      dependencies: {
        'netstandard2.0': swapped['netstandard2.0'],
        'net8.0': swapped['net8.0'],
      },
    });
    const check = confirmed(
      format('packages.lock.json'),
      side(before, [project('13.0.3')]),
      side(after, [project('13.0.3')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('stays claimed and names a hand-bumped direct entry', () => {
    const check = confirmed(
      format('packages.lock.json'),
      side(lock('13.0.3', '4.7.0'), [project('13.0.3')]),
      side(lock('99.0.0', '4.7.0'), [project('13.0.3')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('newtonsoft.json 13.0.3 → 99.0.0');
  });

  it('takes the version from Directory.Packages.props when the project names none', () => {
    const props = (json: string): string => `
<Project>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="${json}" />
  </ItemGroup>
</Project>
`;
    const withoutVersion = project('13.0.3').replace(' Version="13.0.3"', '');
    const check = confirmed(
      format('packages.lock.json'),
      side(lock('13.0.3', '4.7.0'), [withoutVersion, props('13.0.3')]),
      side(lock('13.0.1', '4.7.0'), [withoutVersion, props('13.0.1')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('takes the version from a PackageReference VersionOverride', () => {
    const override = (json: string): string => `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" VersionOverride="${json}" />
  </ItemGroup>
</Project>
`;
    const check = confirmed(
      format('packages.lock.json'),
      side(lock('13.0.3', '4.7.0'), [override('13.0.3')]),
      side(lock('13.0.1', '4.7.0'), [override('13.0.1')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('takes the central version from a PackageReference Update in the props', () => {
    const props = (json: string): string => `
<Project>
  <ItemGroup>
    <PackageReference Update="Newtonsoft.Json" Version="${json}" />
  </ItemGroup>
</Project>
`;
    const withoutVersion = project('13.0.3').replace(' Version="13.0.3"', '');
    const check = confirmed(
      format('packages.lock.json'),
      side(lock('13.0.3', '4.7.0'), [withoutVersion, props('13.0.3')]),
      side(lock('13.0.1', '4.7.0'), [withoutVersion, props('13.0.1')]),
    );
    expect(check.outcome).toBe('confirmed');
  });

  it('stays claimed and names a hand-edited libraries section', () => {
    const withLibraries = (sha: string): string => `
{
  "version": 1,
  "dependencies": {
    "net8.0": {
      "Newtonsoft.Json": {
        "type": "Direct",
        "requested": "[13.0.3, 14.0.0)",
        "resolved": "13.0.3",
        "contentHash": "HrC5BXdl00IP9zeV+0Z848QWPAoCr9P3bDEZguI="
      }
    }
  },
  "libraries": {
    "Newtonsoft.Json/13.0.3": {
      "type": "package",
      "sha512": "${sha}"
    }
  }
}
`;
    const check = confirmed(
      format('packages.lock.json'),
      side(withLibraries('sha512-original'), [project('13.0.3')]),
      side(withLibraries('sha512-evil'), [project('13.0.3')]),
    );
    expect(check.outcome).toBe('unexplained');
    expect(check.blindSpot).toContain('the libraries section entry (content changed)');
  });

  it('runs no check when no manifest names the dependencies', () => {
    const check = confirmed(
      format('packages.lock.json'),
      side(lock('13.0.3', '4.7.0'), []),
      side(lock('13.0.1', '4.7.0'), []),
    );
    expect(check.outcome).toBe('no check');
    expect(check.blindSpot).toContain('no check for this lockfile');
  });
});

describe('the checks spawn no process', () => {
  it('runs every format without touching child_process', () => {
    const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
    const spies = names.map((name) =>
      vi.spyOn(childProcess, name).mockImplementation(() => {
        throw new Error(`the lock file check tried to start a process with ${name}`);
      }),
    );
    syncBuiltinESMExports();
    try {
      for (const lockfile of ['package-lock.json', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'packages.lock.json']) {
        const found = format(lockfile);
        confirmLockfileChange(found, found.name, side('{}', ['{}']), side('{}', ['{}']));
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      syncBuiltinESMExports();
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('manifest discovery inside the copies', () => {
  /** A versionless project: the central props owns the version. */
  const project = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" />
  </ItemGroup>
</Project>
`;
  const props = (json: string): string => `<Project>
  <ItemGroup>
    <PackageReference Update="Newtonsoft.Json" Version="${json}" />
  </ItemGroup>
</Project>
`;
  const lock = (json: string): string => `
{
  "version": 1,
  "dependencies": {
    "net8.0": {
      "Newtonsoft.Json": {
        "type": "Direct",
        "requested": "[${json}, 14.0.0)",
        "resolved": "${json}",
        "contentHash": "HrC5BXdl00IP9zeV+0Z848QWPAoCr9P3bDEZguI="
      }
    }
  },
  "libraries": {
    "Newtonsoft.Json/${json}": {
      "type": "package",
      "sha512": "sha512-${json}"
    }
  }
}
`;

  /** Runs the discovery-driven check on a central-version bump 13.0.1 → 13.0.3. */
  async function assess(lockPath: string): Promise<{ state: string; rule: string }> {
    const files = (json: string): Record<string, string> => ({
      [lockPath]: lock(json),
      [dirname(lockPath) === '.' ? 'App.csproj' : `${dirname(lockPath)}/App.csproj`]: project,
      'Directory.Packages.props': props(json),
    });
    const base = copyWith(files('13.0.1'));
    const head = copyWith(files('13.0.3'));
    try {
      const overrides = await confirmLockfileNoise([lockfilePart(lockPath)], { base, head });
      const assessment = overrides.get(lockPath);
      if (assessment === undefined || assessment.label === 'none') {
        throw new Error(`expected a labelled lockfile assessment for ${lockPath}`);
      }
      return { state: assessment.state, rule: assessment.rule };
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(head, { recursive: true, force: true });
    }
  }

  it('reads a repository-root Directory.Packages.props from beside a nested packages.lock.json', async () => {
    const assessment = await assess('src/packages.lock.json');
    expect(assessment.state).toBe('confirmed');
    expect(assessment.rule).toBe('lockfile-follows-manifest');
  });

  it('lists the copy root for a root-level packages.lock.json', async () => {
    const assessment = await assess('packages.lock.json');
    expect(assessment.state).toBe('confirmed');
    expect(assessment.rule).toBe('lockfile-follows-manifest');
  });
});

describe('workspace members', () => {
  describe('package-lock.json', () => {
    const root = JSON.stringify({
      name: 'app',
      private: true,
      workspaces: ['packages/*', '!packages/legacy'],
      dependencies: { 'left-pad': '^1.3.0' },
    });
    const api = (isEven: string): string =>
      JSON.stringify({ name: 'api', version: '1.0.0', dependencies: { 'is-even': `^${isEven}` } });
    const web = JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { 'is-odd': '^3.0.1' } });
    const legacy = (version: string): string => JSON.stringify({ name: 'legacy', version });
    const lock = (options: {
      isEven: string;
      withWeb?: boolean;
      smuggled?: boolean;
      legacyVersion?: string;
    }): string =>
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'app',
            workspaces: ['packages/*', '!packages/legacy'],
            dependencies: { 'left-pad': '^1.3.0' },
          },
          'node_modules/api': { resolved: 'packages/api', link: true },
          'node_modules/is-even': {
            version: options.isEven,
            resolved: `https://registry.npmjs.org/is-even/-/is-even-${options.isEven}.tgz`,
            integrity: `sha512-is-even-${options.isEven}`,
            ...(options.isEven === '1.0.0' ? {} : { dependencies: { 'is-number': '^7.0.0' } }),
          },
          ...(options.isEven === '1.0.0'
            ? {}
            : { 'node_modules/is-number': { version: '7.0.0', integrity: 'sha512-is-number' } }),
          'node_modules/left-pad': { version: '1.3.0', integrity: 'sha512-left-pad' },
          ...(options.withWeb === true
            ? {
                'node_modules/web': { resolved: 'packages/web', link: true },
                'node_modules/is-odd': { version: '3.0.1', integrity: 'sha512-is-odd' },
                'packages/web': { name: 'web', version: '1.0.0', dependencies: { 'is-odd': '^3.0.1' } },
              }
            : {}),
          ...(options.smuggled === true
            ? { 'node_modules/evil-pkg': { version: '6.6.6', integrity: 'sha512-evil' } }
            : {}),
          ...(options.legacyVersion === undefined
            ? {}
            : { 'packages/legacy': { name: 'legacy', version: options.legacyVersion } }),
          'packages/api': { name: 'api', version: '1.0.0', dependencies: { 'is-even': '^1.0.0' } },
        },
      });
    const files = (
      lockText: string,
      apiManifest: string,
      extra: Record<string, string> = {},
    ): Record<string, string> => ({
      'package.json': root,
      'package-lock.json': lockText,
      'packages/api/package.json': apiManifest,
      ...extra,
    });

    it('confirms adding a workspace member: its record, its link stub and its own dependencies', async () => {
      const assessment = await assessCopies(
        'package-lock.json',
        files(lock({ isEven: '1.0.0' }), api('1.0.0')),
        files(lock({ isEven: '1.0.0', withWeb: true }), api('1.0.0'), { 'packages/web/package.json': web }),
      );
      expect(assessment.state).toBe('confirmed');
      expect(assessment.rule).toBe('lockfile-follows-manifest');
    });

    it('confirms a member bumping its own dependency', async () => {
      const bumped = lock({ isEven: '1.1.0' }).replace('"is-even":"^1.0.0"}}}', '"is-even":"^1.1.0"}}}');
      const assessment = await assessCopies(
        'package-lock.json',
        files(lock({ isEven: '1.0.0' }), api('1.0.0')),
        files(bumped, api('1.1.0')),
      );
      expect(assessment.state).toBe('confirmed');
    });

    it('stays claimed and names an entry smuggled in beside a member bump', async () => {
      const bumped = lock({ isEven: '1.1.0', smuggled: true }).replace(
        '"is-even":"^1.0.0"}}}',
        '"is-even":"^1.1.0"}}}',
      );
      const assessment = await assessCopies(
        'package-lock.json',
        files(lock({ isEven: '1.0.0' }), api('1.0.0')),
        files(bumped, api('1.1.0')),
      );
      expect(assessment.state).toBe('claimed');
      expect(assessment.rule).toBe('lockfile-unexplained');
      expect(assessment.blindSpot).toContain('evil-pkg@6.6.6');
      expect(assessment.blindSpot).not.toContain('is-even');
      expect(assessment.blindSpot).not.toContain('packages/api');
    });

    it('stays claimed and names the record of a directory the workspace excludes', async () => {
      const assessment = await assessCopies(
        'package-lock.json',
        files(lock({ isEven: '1.0.0', legacyVersion: '1.0.0' }), api('1.0.0'), {
          'packages/legacy/package.json': legacy('1.0.0'),
        }),
        files(lock({ isEven: '1.0.0', legacyVersion: '2.0.0' }), api('1.0.0'), {
          'packages/legacy/package.json': legacy('2.0.0'),
        }),
      );
      expect(assessment.state).toBe('claimed');
      expect(assessment.blindSpot).toContain('the packages/legacy entry (content changed)');
    });
  });

  describe('uv.lock', () => {
    const root = `
[project]
name = "app"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["anyio>=4.3"]

[tool.uv.workspace]
members = ["packages/*"]
exclude = ["packages/scratch"]
`;
    const memberA = (httpx: string): string => `
[project]
name = "member-a"
version = "0.1.0"
dependencies = ["httpx>=${httpx}"]
`;
    const memberB = `
[project]
name = "Member_B"
version = "0.1.0"
dependencies = ["sniffio>=1.3"]
`;
    const registry = 'source = { registry = "https://pypi.org/simple" }';
    const lock = (options: { httpx: string; withB?: boolean; smuggled?: boolean }): string => `
version = 1
requires-python = ">=3.11"

[manifest]
members = ["app", "member-a"${options.withB === true ? ', "member-b"' : ''}]

[[package]]
name = "anyio"
version = "4.3.0"
${registry}
dependencies = [{ name = "idna" }]

[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{ name = "anyio" }]

[package.metadata]
requires-dist = [{ name = "anyio", specifier = ">=4.3" }]

[[package]]
name = "httpx"
version = "${options.httpx}.0"
${registry}
dependencies = [{ name = "anyio" }, { name = "idna" }]

[[package]]
name = "idna"
version = "3.7"
${registry}

[[package]]
name = "member-a"
version = "0.1.0"
source = { editable = "packages/member-a" }
dependencies = [{ name = "httpx" }]

[package.metadata]
requires-dist = [{ name = "httpx", specifier = ">=${options.httpx}" }]
${
  options.withB === true
    ? `
[[package]]
name = "member-b"
version = "0.1.0"
source = { editable = "packages/member-b" }
dependencies = [{ name = "sniffio" }]

[package.metadata]
requires-dist = [{ name = "sniffio", specifier = ">=1.3" }]

[[package]]
name = "sniffio"
version = "1.3.1"
${registry}
`
    : ''
}${options.smuggled === true ? `\n[[package]]\nname = "smuggled"\nversion = "1.0"\n${registry}\n` : ''}`;
    const files = (lockText: string, httpx: string, extra: Record<string, string> = {}): Record<string, string> => ({
      'pyproject.toml': root,
      'uv.lock': lockText,
      'packages/member-a/pyproject.toml': memberA(httpx),
      ...extra,
    });

    it('confirms adding a workspace member and its own dependencies', async () => {
      const assessment = await assessCopies(
        'uv.lock',
        files(lock({ httpx: '0.27' }), '0.27'),
        files(lock({ httpx: '0.27', withB: true }), '0.27', { 'packages/member-b/pyproject.toml': memberB }),
      );
      expect(assessment.state).toBe('confirmed');
    });

    it('confirms a member bumping its own dependency, its own entry with it', async () => {
      const assessment = await assessCopies(
        'uv.lock',
        files(lock({ httpx: '0.27' }), '0.27'),
        files(lock({ httpx: '0.28' }), '0.28'),
      );
      expect(assessment.state).toBe('confirmed');
    });

    it('stays claimed and names an entry smuggled in beside a member bump', async () => {
      const assessment = await assessCopies(
        'uv.lock',
        files(lock({ httpx: '0.27' }), '0.27'),
        files(lock({ httpx: '0.28', smuggled: true }), '0.28'),
      );
      expect(assessment.state).toBe('claimed');
      expect(assessment.blindSpot).toContain('smuggled@1.0');
      expect(assessment.blindSpot).not.toContain('httpx');
      expect(assessment.blindSpot).not.toContain('member-a');
    });

    it('stays claimed and names a member entry whose pyproject.toml the pull request leaves alone', async () => {
      const assessment = await assessCopies(
        'uv.lock',
        files(lock({ httpx: '0.27' }), '0.27'),
        files(lock({ httpx: '0.28' }), '0.27'),
      );
      expect(assessment.state).toBe('claimed');
      expect(assessment.blindSpot).toContain('the member-a entry (content changed)');
    });

    it('reads no member from a directory the workspace excludes', async () => {
      const scratch = lock({ httpx: '0.27', withB: true }).replaceAll('packages/member-b', 'packages/scratch');
      const assessment = await assessCopies(
        'uv.lock',
        files(lock({ httpx: '0.27' }), '0.27'),
        files(scratch, '0.27', { 'packages/scratch/pyproject.toml': memberB }),
      );
      expect(assessment.state).toBe('claimed');
      expect(assessment.blindSpot).toContain('member-b@0.1.0');
    });
  });

  describe('Cargo.lock', () => {
    const root = `
[workspace]
members = ["crates/*"]
exclude = ["crates/scratch"]
resolver = "2"

[workspace.dependencies]
serde = "1.0"
`;
    const core = (itoa: string): string => `
[package]
name = "core-lib"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { workspace = true }
itoa = "${itoa}"
`;
    const cli = `
[package]
name = "app-cli"
version = "0.1.0"
edition = "2021"

[dependencies]
core-lib = { path = "../core" }
anyhow = "1.0"
`;
    const registry = 'source = "registry+https://github.com/rust-lang/crates.io-index"';
    const lock = (options: { itoa: string; withCli?: boolean; smuggled?: boolean }): string => `
# This file is automatically @generated by Cargo.
version = 3
${
  options.withCli === true
    ? `
[[package]]
name = "anyhow"
version = "1.0.86"
${registry}
checksum = "anyhow-1.0.86"

[[package]]
name = "app-cli"
version = "0.1.0"
dependencies = [
 "anyhow",
 "core-lib",
]
`
    : ''
}
[[package]]
name = "core-lib"
version = "0.1.0"
dependencies = [
 "itoa",
${options.smuggled === true ? ' "once_cell",\n' : ''} "serde",
]

[[package]]
name = "itoa"
version = "${options.itoa}"
${registry}
checksum = "itoa-${options.itoa}"
${options.smuggled === true ? `\n[[package]]\nname = "once_cell"\nversion = "1.19.0"\n${registry}\nchecksum = "once-cell"\n` : ''}
[[package]]
name = "serde"
version = "1.0.204"
${registry}
checksum = "serde-1.0.204"
`;
    const files = (lockText: string, itoa: string, extra: Record<string, string> = {}): Record<string, string> => ({
      'Cargo.toml': root,
      'Cargo.lock': lockText,
      'crates/core/Cargo.toml': core(itoa),
      ...extra,
    });

    it('confirms adding a workspace member, its own entry recorded with no path', async () => {
      const assessment = await assessCopies(
        'Cargo.lock',
        files(lock({ itoa: '1.0.10' }), '1.0.10'),
        files(lock({ itoa: '1.0.10', withCli: true }), '1.0.10', { 'crates/cli/Cargo.toml': cli }),
      );
      expect(assessment.state).toBe('confirmed');
    });

    it('confirms a member bumping its own dependency', async () => {
      const assessment = await assessCopies(
        'Cargo.lock',
        files(lock({ itoa: '1.0.10' }), '1.0.10'),
        files(lock({ itoa: '1.0.11' }), '1.0.11'),
      );
      expect(assessment.state).toBe('confirmed');
    });

    it('stays claimed and names a crate smuggled into a member entry beside a bump', async () => {
      const assessment = await assessCopies(
        'Cargo.lock',
        files(lock({ itoa: '1.0.10' }), '1.0.10'),
        files(lock({ itoa: '1.0.11', smuggled: true }), '1.0.11'),
      );
      expect(assessment.state).toBe('claimed');
      expect(assessment.blindSpot).toContain('the core-lib entry (content changed)');
      expect(assessment.blindSpot).toContain('once-cell@1.19.0');
      expect(assessment.blindSpot).not.toContain('itoa');
    });

    it('reads no member from a directory the workspace excludes', async () => {
      const scratch = cli.replace('app-cli', 'scratch');
      const assessment = await assessCopies(
        'Cargo.lock',
        files(lock({ itoa: '1.0.10' }), '1.0.10'),
        files(lock({ itoa: '1.0.10', withCli: true }).replace('"app-cli"', '"scratch"'), '1.0.10', {
          'crates/scratch/Cargo.toml': scratch,
        }),
      );
      expect(assessment.state).toBe('claimed');
      expect(assessment.blindSpot).toContain('scratch@0.1.0');
    });
  });

  it('expands nested globs and bracket classes', async () => {
    const rootManifest = JSON.stringify({ name: 'app', workspaces: ['libs/**', 'apps/[a-m]*'] });
    const lock = (withMembers: boolean): string =>
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', workspaces: ['libs/**', 'apps/[a-m]*'] },
          ...(withMembers
            ? {
                'node_modules/ui': { resolved: 'libs/group/ui', link: true },
                'libs/group/ui': { name: 'ui', version: '1.0.0' },
                'node_modules/admin': { resolved: 'apps/admin', link: true },
                'apps/admin': { name: 'admin', version: '1.0.0' },
              }
            : {}),
        },
      });
    const base = { 'package.json': rootManifest, 'package-lock.json': lock(false) };
    const assessment = await assessCopies('package-lock.json', base, {
      ...base,
      'package-lock.json': lock(true),
      'libs/group/ui/package.json': JSON.stringify({ name: 'ui', version: '1.0.0' }),
      'apps/admin/package.json': JSON.stringify({ name: 'admin', version: '1.0.0' }),
    });
    expect(assessment.state).toBe('confirmed');
    const outside = await assessCopies('package-lock.json', base, {
      ...base,
      'package-lock.json': lock(true).replaceAll('apps/admin', 'apps/zeta'),
      'libs/group/ui/package.json': JSON.stringify({ name: 'ui', version: '1.0.0' }),
      'apps/zeta/package.json': JSON.stringify({ name: 'admin', version: '1.0.0' }),
    });
    expect(outside.state).toBe('claimed');
    expect(outside.blindSpot).toContain('the apps/zeta entry (added)');
  });

  it('lists the member manifests among the manifests a case must carry', async () => {
    const copy = copyWith({
      'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
      'packages/api/package.json': '{}',
      'packages/notes.txt': '',
    });
    try {
      expect(await lockfileManifests(['package-lock.json'], copy)).toEqual([
        'package.json',
        'packages/api/package.json',
      ]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('discovers members by reading files, never by starting a process', async () => {
    const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
    const spies = names.map((name) =>
      vi.spyOn(childProcess, name).mockImplementation(() => {
        throw new Error(`the workspace discovery tried to start a process with ${name}`);
      }),
    );
    syncBuiltinESMExports();
    const workspaces: Record<string, Record<string, string>> = {
      'package-lock.json': {
        'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/**'] }),
        'packages/api/package.json': JSON.stringify({ name: 'api' }),
      },
      'uv.lock': {
        'pyproject.toml': '[tool.uv.workspace]\nmembers = ["packages/*"]\n',
        'packages/api/pyproject.toml': '[project]\nname = "api"\n',
      },
      'Cargo.lock': {
        'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
        'crates/api/Cargo.toml': '[package]\nname = "api"\n',
      },
    };
    try {
      for (const [lockPath, files] of Object.entries(workspaces)) {
        await assessCopies(lockPath, { ...files, [lockPath]: '' }, { ...files, [lockPath]: '' });
        const copy = copyWith(files);
        try {
          expect((await lockfileManifests([lockPath], copy)).length).toBe(2);
        } finally {
          rmSync(copy, { recursive: true, force: true });
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      syncBuiltinESMExports();
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
