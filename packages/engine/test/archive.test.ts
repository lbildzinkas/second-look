import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTarball, pathInCopy } from '../src/archive.js';
import { removeCopy } from '../src/cache.js';
import { paxRecord, tarball, temporaryCacheDir } from './helpers.js';

/** Streams a buffer in small chunks, as a download would arrive. */
async function* chunks(buffer: Buffer, size = 100): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size);
  }
}

let root: string;
let copy: string;

beforeEach(() => {
  root = temporaryCacheDir();
  copy = join(root, 'copy');
});

afterEach(async () => {
  await removeCopy(root);
});

describe('extractTarball', () => {
  it('writes every file under the top folder, read-only', async () => {
    const archive = tarball([
      { path: 'pax_global_header', type: 'g', content: paxRecord('comment', 'abc') },
      { path: 'repo-abc/', type: '5' },
      { path: 'repo-abc/README.md', content: '# Title\n' },
      { path: 'repo-abc/src/deep/main.py', content: 'print(1)\n' },
    ]);
    const result = await extractTarball(chunks(archive), copy);

    expect(result).toEqual({ files: 2, skipped: [] });
    expect(readFileSync(join(copy, 'src', 'deep', 'main.py'), 'utf8')).toBe('print(1)\n');
    expect(lstatSync(join(copy, 'README.md')).mode & 0o777).toBe(0o444);
    expect(lstatSync(join(copy, 'src', 'deep')).mode & 0o777).toBe(0o555);
    expect(lstatSync(copy).mode & 0o777).toBe(0o555);
  });

  it('reads long paths from pax and GNU headers', async () => {
    const long = `${'nested/'.repeat(20)}file.txt`;
    const archive = tarball([
      { path: 'PaxHeader', type: 'x', content: paxRecord('path', `repo-abc/${long}`) },
      { path: 'repo-abc/truncated', content: 'pax' },
      { path: '././@LongLink', type: 'L', content: `repo-abc/gnu/${long}\0` },
      { path: 'repo-abc/truncated-too', content: 'gnu' },
    ]);
    await extractTarball(chunks(archive), copy);
    expect(readFileSync(join(copy, ...long.split('/')), 'utf8')).toBe('pax');
    expect(readFileSync(join(copy, 'gnu', ...long.split('/')), 'utf8')).toBe('gnu');
  });

  it('skips links and refuses paths that leave the copy', async () => {
    const archive = tarball([
      { path: 'repo-abc/link', type: '2', linkName: '/etc/passwd' },
      { path: 'repo-abc/../escape.txt', content: 'out' },
      { path: '/absolute.txt', content: 'out' },
      { path: 'repo-abc/kept.txt', content: 'in' },
    ]);
    const result = await extractTarball(chunks(archive), copy);

    expect(result.files).toBe(1);
    expect(result.skipped).toEqual([
      'link: not a regular file',
      'repo-abc/../escape.txt: path leaves the copy',
      '/absolute.txt: path leaves the copy',
    ]);
    expect(readdirSync(copy)).toEqual(['kept.txt']);
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
  });

  it('fails on a truncated archive', async () => {
    const archive = tarball([{ path: 'repo-abc/big.txt', content: 'x'.repeat(5000) }]);
    const cut = gzipSync(gunzipSync(archive).subarray(0, 1024));
    await expect(extractTarball(chunks(cut), copy)).rejects.toThrow(/ends in the middle/);
  });
});

describe('pathInCopy', () => {
  it('resolves diff paths inside the copy and refuses the rest', () => {
    expect(pathInCopy('/cache/copy', 'src/a.ts')).toBe(resolve('/cache/copy', 'src', 'a.ts'));
    expect(pathInCopy('/cache/copy', '../outside.ts')).toBeUndefined();
  });
});
