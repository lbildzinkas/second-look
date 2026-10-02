import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { LockfileFormat } from '../src/lockfile.js';
import { confirmLockfileChange, lockfileFormatFor } from '../src/lockfile.js';
import type { LockfileSide } from '../src/lockfile.js';

function format(name: string): LockfileFormat {
  const found = lockfileFormatFor(name);
  if (found === undefined) throw new Error(`no format for ${name}`);
  return found;
}

/** Both sides of one lock file's story, from raw texts. */
function side(lock: string | null, manifests: readonly string[] = []): LockfileSide {
  return { lock, manifests };
}

function confirmed(
  format: LockfileFormat,
  oldSide: LockfileSide,
  newSide: LockfileSide,
): ReturnType<typeof confirmLockfileChange> {
  return confirmLockfileChange(format, format.name, oldSide, newSide);
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
    expect(check.blindSpot).toContain('the dependencies mirror entry (content changed)');
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
    <PackageReference Include="Newtonsoft.Json" Version="${json}" />
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
