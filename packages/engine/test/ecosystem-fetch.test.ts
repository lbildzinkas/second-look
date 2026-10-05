import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { fetchEcosystemLibrary, findEcosystemPin, goModuleHash, type EcosystemPin } from '../src/ecosystem-fetch.js';
import { readZipEntries } from '../src/zip.js';
import { recordedFetch, sha256Hex, tarball, temporaryCacheDir, zipArchive } from './helpers.js';

/** A head copy holding the given files, by forward-slash path. */
function headWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'second-look-head-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, ...path.split('/'))), { recursive: true });
    writeFileSync(join(root, ...path.split('/')), content);
  }
  return root;
}

function digest(algorithm: string, bytes: Buffer, encoding: 'hex' | 'base64' = 'hex'): string {
  return createHash(algorithm).update(bytes).digest(encoding);
}

const INDEX = "module.exports = function ms(value) { return typeof value === 'string' ? parse(value) : format(value); };\n";

/** A small npm package tarball, laid out as the registry serves one: every file under `package/`. */
function npmPackage(index = INDEX): Buffer {
  return tarball([
    { path: 'package/package.json', content: '{ "name": "ms", "version": "2.1.3", "scripts": { "postinstall": "node evil.js" } }\n' },
    { path: 'package/index.js', content: index },
  ]);
}

let cacheDir: string;
let librariesDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
  librariesDir = join(cacheDir, 'libraries');
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('findEcosystemPin', () => {
  const SHA512 = Buffer.alloc(64, 7);

  it("reads package-lock.json's shallowest install from npm's registry, with the SHA-512 its integrity records", async () => {
    const root = headWith({
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/debug/node_modules/ms': { version: '2.0.0', resolved: 'https://registry.npmjs.org/ms/-/ms-2.0.0.tgz', integrity: 'sha512-AAAA' },
          'node_modules/ms': {
            version: '2.1.3',
            resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
            integrity: `sha1-abc sha512-${SHA512.toString('base64')}`,
          },
          'node_modules/@types/node': {
            version: '22.1.0',
            resolved: 'https://registry.npmjs.org/@types/node/-/node-22.1.0.tgz',
            integrity: `sha512-${SHA512.toString('base64')}`,
          },
        },
      }),
    });

    await expect(findEcosystemPin(root, 'ms')).resolves.toEqual({ ecosystem: 'npm', name: 'ms', version: '2.1.3', pinnedBy: 'package-lock.json', hash: SHA512.toString('hex') });
    await expect(findEcosystemPin(root, '@types/node')).resolves.toMatchObject({ name: '@types/node', version: '22.1.0' });
  });

  it('finds no npm pin for a package from elsewhere, a link, an alias that steers the name, or one with no SHA-512', async () => {
    const integrity = `sha512-${SHA512.toString('base64')}`;
    const root = headWith({
      'package-lock.json': JSON.stringify({
        packages: {
          'node_modules/private': { version: '1.0.0', resolved: 'https://npm.example.com/private/-/private-1.0.0.tgz', integrity },
          'node_modules/local': { resolved: 'packages/local', link: true },
          'node_modules/forked': { version: '1.0.0', resolved: 'git+ssh://git@github.com/someone/forked.git#abc', integrity },
          'node_modules/old': { version: '1.0.0', resolved: 'https://registry.npmjs.org/old/-/old-1.0.0.tgz', integrity: 'sha1-abc' },
          'node_modules/sneaky': { name: '../../etc', version: '1.0.0', integrity },
        },
      }),
    });

    for (const name of ['private', 'local', 'forked', 'old', 'sneaky', 'absent']) await expect(findEcosystemPin(root, name)).resolves.toBeUndefined();
  });

  it("reads an aliased package by its registry name, and a lock below the root, but never one inside node_modules", async () => {
    const integrity = `sha512-${SHA512.toString('base64')}`;
    const root = headWith({
      'node_modules/ms/package-lock.json': JSON.stringify({ packages: { 'node_modules/ms': { version: '0.0.1', integrity } } }),
      'web/package-lock.json': JSON.stringify({
        packages: { 'node_modules/ms': { name: 'ms-fork', version: '3.0.0', resolved: 'https://registry.npmjs.org/ms-fork/-/ms-fork-3.0.0.tgz', integrity } },
      }),
    });

    await expect(findEcosystemPin(root, 'ms')).resolves.toMatchObject({ name: 'ms-fork', version: '3.0.0', pinnedBy: 'web/package-lock.json' });
  });

  it("reads Cargo.lock's crates.io packages with their checksum, comparing names as crates.io does, the highest version when it locks several", async () => {
    const root = headWith({
      'Cargo.lock': [
        'version = 3',
        '',
        '[[package]]',
        'name = "cfg-if"',
        'version = "0.1.10"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        `checksum = "${'a'.repeat(64)}"`,
        '',
        '[[package]]',
        'name = "cfg-if"',
        'version = "1.0.0"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        `checksum = "${'b'.repeat(64)}"`,
        '',
        '[[package]]',
        'name = "forked"',
        'version = "1.0.0"',
        'source = "git+https://github.com/someone/forked#abc"',
        '',
        '[[package]]',
        'name = "app"',
        'version = "0.1.0"',
      ].join('\n'),
    });

    await expect(findEcosystemPin(root, 'cfg_if')).resolves.toEqual({ ecosystem: 'Cargo', name: 'cfg-if', version: '1.0.0', pinnedBy: 'Cargo.lock', hash: 'b'.repeat(64) });
    await expect(findEcosystemPin(root, 'forked')).resolves.toBeUndefined();
    await expect(findEcosystemPin(root, 'app')).resolves.toBeUndefined();
  });

  it("reads go.sum at the version go.mod requires, matching an import path to the longest module holding it", async () => {
    const root = headWith({
      'go.mod': [
        'module example.com/app',
        '',
        'go 1.22',
        '',
        'require (',
        '\tgithub.com/pkg/errors v0.9.1',
        '\tgolang.org/x/net v0.20.0 // indirect',
        '\tgithub.com/someone/forked v1.0.0',
        ')',
        '',
        'require golang.org/x/net/http2 v9.9.9',
        '',
        'replace github.com/someone/forked => ../forked',
      ].join('\n'),
      'go.sum': [
        'github.com/pkg/errors v0.8.0 h1:old=',
        'github.com/pkg/errors v0.9.1 h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=',
        'github.com/pkg/errors v0.9.1/go.mod h1:bwawxfHBFNV+L2hUp1rHADufV3IMtnDRdf1r5NINEl0=',
        'golang.org/x/net v0.20.0 h1:net=',
        'github.com/someone/forked v1.0.0 h1:forked=',
      ].join('\n'),
    });

    await expect(findEcosystemPin(root, 'github.com/pkg/errors')).resolves.toEqual({
      ecosystem: 'Go',
      name: 'github.com/pkg/errors',
      version: 'v0.9.1',
      pinnedBy: 'go.sum',
      hash: 'h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=',
    });
    await expect(findEcosystemPin(root, 'golang.org/x/net/html')).resolves.toMatchObject({ name: 'golang.org/x/net', version: 'v0.20.0', hash: 'h1:net=' });
    // http2 is required as its own module, but go.sum records no hash of it.
    await expect(findEcosystemPin(root, 'golang.org/x/net/http2')).resolves.toBeUndefined();
    // A replaced module is pinned to other code.
    await expect(findEcosystemPin(root, 'github.com/someone/forked')).resolves.toBeUndefined();
  });

  it('finds no Go pin for a module path with a dot segment, which could steer a path', async () => {
    const root = headWith({ 'go.mod': 'module app\n\nrequire example.com/../x v1.0.0\n', 'go.sum': 'example.com/../x v1.0.0 h1:x=\n' });

    await expect(findEcosystemPin(root, 'example.com/../x')).resolves.toBeUndefined();
  });

  it("reads a pom.xml's dependencies at a literal version or one of its properties, by group and artifact or artifact alone, and a gradle.lockfile", async () => {
    const root = headWith({
      'pom.xml': [
        '<project>',
        '  <properties><jackson.version>2.17.1</jackson.version></properties>',
        '  <dependencies>',
        '    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.13</version></dependency>',
        '    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>${jackson.version}</version></dependency>',
        '    <dependency><groupId>org.ranged</groupId><artifactId>ranged</artifactId><version>[1.0,2.0)</version></dependency>',
        '    <!-- <dependency><groupId>org.gone</groupId><artifactId>gone</artifactId><version>1.0</version></dependency> -->',
        '  </dependencies>',
        '</project>',
      ].join('\n'),
      'service/gradle.lockfile': '# Gradle lock\ncom.google.guava:guava:33.2.1-jre=compileClasspath,runtimeClasspath\nempty=\n',
    });

    await expect(findEcosystemPin(root, 'org.slf4j:slf4j-api')).resolves.toEqual({ ecosystem: 'Maven', name: 'org.slf4j:slf4j-api', version: '2.0.13', pinnedBy: 'pom.xml' });
    await expect(findEcosystemPin(root, 'jackson-databind')).resolves.toMatchObject({ name: 'com.fasterxml.jackson.core:jackson-databind', version: '2.17.1' });
    await expect(findEcosystemPin(root, 'guava')).resolves.toMatchObject({ name: 'com.google.guava:guava', version: '33.2.1-jre', pinnedBy: 'service/gradle.lockfile' });
    await expect(findEcosystemPin(root, 'ranged')).resolves.toBeUndefined();
    await expect(findEcosystemPin(root, 'gone')).resolves.toBeUndefined();
  });
});

describe('goModuleHash', () => {
  it("hashes a module's zip as go.sum's h1 does: a sorted summary of each file's SHA-256 and name", () => {
    const files = { 'example.com/m@v1.0.0/go.mod': 'module example.com/m\n', 'example.com/m@v1.0.0/a.go': 'package m\n' };
    const zip = zipArchive(Object.entries(files).map(([name, content]) => ({ name, content })));
    const summary = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, content]) => `${digest('sha256', Buffer.from(content))}  ${name}\n`)
      .join('');

    expect(goModuleHash(readZipEntries(zip))).toBe(`h1:${digest('sha256', Buffer.from(summary), 'base64')}`);
  });
});

describe('fetchEcosystemLibrary', () => {
  const npmPin = (bytes: Buffer): EcosystemPin => ({ ecosystem: 'npm', name: 'ms', version: '2.1.3', pinnedBy: 'package-lock.json', hash: digest('sha512', bytes) });

  it("downloads an npm package's tarball from npm's registry, checks its SHA-512 and unpacks it read-only, running no script", async () => {
    const bytes = npmPackage();
    const transport = recordedFetch({ 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz': bytes });

    const fetched = await fetchEcosystemLibrary(npmPin(bytes), { librariesDir, fetch: transport.fetch });

    expect(fetched).toEqual({ file: 'ms-2.1.3.tgz', sha256: sha256Hex(bytes), archive: 'npm package', path: expect.stringContaining(join(librariesDir, 'npm-ms-2.1.3-')), reused: false });
    expect(readFileSync(join(fetched.path, 'index.js'), 'utf8')).toBe(INDEX);
    expect(statSync(join(fetched.path, 'index.js')).mode & 0o777).toBe(0o444);
    expect(statSync(fetched.path).mode & 0o777).toBe(0o555);
    expect(transport.requests.map((request) => request.url)).toEqual(['https://registry.npmjs.org/ms/-/ms-2.1.3.tgz']);
  });

  it('downloads a scoped package from its scope on the registry', async () => {
    const bytes = npmPackage();
    const transport = recordedFetch({ 'https://registry.npmjs.org/@types/node/-/node-22.1.0.tgz': bytes });

    const fetched = await fetchEcosystemLibrary({ ...npmPin(bytes), name: '@types/node', version: '22.1.0' }, { librariesDir, fetch: transport.fetch });

    expect(fetched.path).toContain(join(librariesDir, 'npm-_types_node-22.1.0-'));
  });

  it('aborts on a hash mismatch with a clear message, and unpacks nothing', async () => {
    const pinned = npmPackage();
    const tampered = npmPackage('require("child_process").exec("curl evil")\n');
    const transport = recordedFetch({ 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz': tampered });

    await expect(fetchEcosystemLibrary(npmPin(pinned), { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      `the download of ms-2.1.3.tgz does not match the hash package-lock.json gives (expected ${digest('sha512', pinned)}, got ${digest('sha512', tampered)}); nothing was unpacked`,
    );
    expect(existsSync(librariesDir) ? readdirSync(librariesDir) : []).toEqual([]);
  });

  it('reuses an earlier fetch of the same file without downloading it again', async () => {
    const bytes = npmPackage();
    const transport = recordedFetch({ 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz': bytes });
    const first = await fetchEcosystemLibrary(npmPin(bytes), { librariesDir, fetch: transport.fetch });

    const second = await fetchEcosystemLibrary(npmPin(bytes), { librariesDir, fetch: transport.fetch });

    expect(second).toEqual({ ...first, reused: true });
    expect(transport.requests).toHaveLength(1);
  });

  it("downloads a crate from crates.io's own host, checks its SHA-256, and skips links and paths that would leave the cache", async () => {
    const bytes = tarball([
      { path: 'cfg-if-1.0.0/Cargo.toml', content: '[package]\nname = "cfg-if"\nbuild = "build.rs"\n' },
      { path: 'cfg-if-1.0.0/build.rs', content: 'fn main() { std::process::Command::new("curl").status().unwrap(); }\n' },
      { path: 'cfg-if-1.0.0/src/lib.rs', content: 'macro_rules! cfg_if { () => {} }\n' },
      { path: 'cfg-if-1.0.0/src/link.rs', type: '2', linkName: '/etc/passwd' },
      { path: 'cfg-if-1.0.0/../../escape.rs', content: 'x\n' },
    ]);
    const transport = recordedFetch({ 'https://static.crates.io/crates/cfg-if/cfg-if-1.0.0.crate': bytes });

    const fetched = await fetchEcosystemLibrary({ ecosystem: 'Cargo', name: 'cfg-if', version: '1.0.0', pinnedBy: 'Cargo.lock', hash: sha256Hex(bytes) }, { librariesDir, fetch: transport.fetch });

    expect(fetched).toMatchObject({ file: 'cfg-if-1.0.0.crate', archive: 'crate', sha256: sha256Hex(bytes) });
    expect(readdirSync(join(fetched.path, 'src'))).toEqual(['lib.rs']);
    expect(statSync(join(fetched.path, 'build.rs')).mode & 0o111).toBe(0);
    expect(existsSync(join(cacheDir, 'escape.rs'))).toBe(false);
  });

  it("downloads a Go module's zip from the module proxy, escaping capitals, checks go.sum's h1 hash, and unpacks it without its module path", async () => {
    const files = [
      { name: 'github.com/!burnt!sushi/toml@v1.3.2/go.mod', content: 'module github.com/BurntSushi/toml\n' },
      { name: 'github.com/!burnt!sushi/toml@v1.3.2/decode.go', content: 'package toml\n' },
    ];
    const bytes = zipArchive(files);
    const pin: EcosystemPin = { ecosystem: 'Go', name: 'github.com/BurntSushi/toml', version: 'v1.3.2', pinnedBy: 'go.sum', hash: goModuleHash(readZipEntries(bytes)) };
    const transport = recordedFetch({ 'https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.3.2.zip': bytes });

    const fetched = await fetchEcosystemLibrary(pin, { librariesDir, fetch: transport.fetch });

    expect(fetched).toMatchObject({ file: 'v1.3.2.zip', archive: 'Go module' });
    expect(readdirSync(fetched.path).sort()).toEqual(['decode.go', 'go.mod']);
    await expect(
      fetchEcosystemLibrary({ ...pin, hash: 'h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=' }, { librariesDir: join(cacheDir, 'other'), fetch: transport.fetch }),
    ).rejects.toThrow(/does not match the hash go.sum gives .*; nothing was unpacked/);
  });

  it("downloads a Maven sources jar from Maven Central, checked against the SHA-1 Central records, since a pom records none", async () => {
    const bytes = zipArchive([
      { name: 'META-INF/MANIFEST.MF', content: 'Manifest-Version: 1.0\n' },
      { name: 'org/slf4j/Logger.java', content: 'public interface Logger {}\n' },
    ]);
    const jar = 'https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.13/slf4j-api-2.0.13-sources.jar';
    const pin: EcosystemPin = { ecosystem: 'Maven', name: 'org.slf4j:slf4j-api', version: '2.0.13', pinnedBy: 'pom.xml' };
    const transport = recordedFetch({ [jar]: bytes, [`${jar}.sha1`]: `${digest('sha1', bytes)}  slf4j-api-2.0.13-sources.jar\n` });

    const fetched = await fetchEcosystemLibrary(pin, { librariesDir, fetch: transport.fetch });

    expect(fetched).toMatchObject({ file: 'slf4j-api-2.0.13-sources.jar', archive: 'sources jar', sha256: sha256Hex(bytes) });
    expect(readFileSync(join(fetched.path, 'org', 'slf4j', 'Logger.java'), 'utf8')).toBe('public interface Logger {}\n');
    expect(transport.requests.map((request) => request.url)).toEqual([`${jar}.sha1`, jar]);

    const wrong = recordedFetch({ [jar]: bytes, [`${jar}.sha1`]: 'f'.repeat(40) });
    await expect(fetchEcosystemLibrary(pin, { librariesDir: join(cacheDir, 'other'), fetch: wrong.fetch })).rejects.toThrow(
      /does not match the hash Maven Central's record of it gives/,
    );
    const missing = recordedFetch({ [`${jar}.sha1`]: 404 });
    await expect(fetchEcosystemLibrary(pin, { librariesDir: join(cacheDir, 'other'), fetch: missing.fetch })).rejects.toThrow(
      'Maven Central has no sources jar of org.slf4j:slf4j-api 2.0.13, or no SHA-1 for it; nothing was downloaded',
    );
  });

  it('says plainly when the host has no such file, and refuses a version that could steer the cache path', async () => {
    const bytes = npmPackage();
    const transport = recordedFetch({ 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz': 404 });

    await expect(fetchEcosystemLibrary(npmPin(bytes), { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      'registry.npmjs.org has no npm package ms 2.1.3; nothing was downloaded',
    );
    await expect(fetchEcosystemLibrary({ ...npmPin(bytes), version: '../2.1.3' }, { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      'not a version a library fetch can download: ../2.1.3',
    );
  });
});
