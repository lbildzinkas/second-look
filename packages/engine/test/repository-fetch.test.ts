import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { fetchNamedRepository, namedRepositoryProblem } from '../src/repository-fetch.js';
import { paxRecord, recordedFetch, sha256Hex, tarball, temporaryCacheDir } from './helpers.js';

const INDEX = 'export default function ms(value) { return value; }\n';

/** A tag's archive laid out as GitHub serves one: a pax comment, then one top folder. */
function tagArchive(): Buffer {
  return tarball([
    { path: 'pax_global_header', type: 'g', content: paxRecord('comment', 'a'.repeat(40)) },
    { path: 'ms-3.0.0/', type: '5' },
    { path: 'ms-3.0.0/src/index.ts', content: INDEX },
    { path: 'ms-3.0.0/scripts/postinstall.sh', content: '#!/bin/sh\ncurl evil\n' },
  ]);
}

const GITHUB_ARCHIVE = 'https://codeload.github.com/vercel/ms/tar.gz/refs/tags/3.0.0';

let cacheDir: string;
let librariesDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
  librariesDir = join(cacheDir, 'libraries');
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('namedRepositoryProblem', () => {
  it('accepts a public GitHub or GitLab repository over https, and a plain tag', () => {
    for (const named of [
      { url: 'https://github.com/vercel/ms', tag: '3.0.0' },
      { url: 'https://github.com/vercel/ms.git/', tag: 'refs/tags/v3.0.0' },
      { url: 'https://www.github.com/vercel/ms', tag: 'release/3.0' },
      { url: 'https://gitlab.com/group/subgroup/project', tag: 'v1.2.3' },
    ]) {
      expect(namedRepositoryProblem(named)).toBeUndefined();
    }
  });

  it('refuses any other host, scheme, user or port, a path that names no repository, and a tag that could steer a path', () => {
    expect(namedRepositoryProblem({ url: 'http://github.com/vercel/ms', tag: '3.0.0' })).toContain('is not one of the hosts a named repository is fetched from (github.com, gitlab.com), over https');
    expect(namedRepositoryProblem({ url: 'https://github.com.evil.example/vercel/ms', tag: '3.0.0' })).toContain('is not one of the hosts');
    expect(namedRepositoryProblem({ url: 'https://token@github.com/vercel/ms', tag: '3.0.0' })).toContain('is not one of the hosts');
    expect(namedRepositoryProblem({ url: 'https://github.com:8443/vercel/ms', tag: '3.0.0' })).toContain('is not one of the hosts');
    expect(namedRepositoryProblem({ url: 'https://10.0.0.1/vercel/ms', tag: '3.0.0' })).toContain('is not one of the hosts');
    expect(namedRepositoryProblem({ url: 'https://github.com/vercel', tag: '3.0.0' })).toBe('https://github.com/vercel names no repository on github.com');
    expect(namedRepositoryProblem({ url: 'https://github.com/vercel/ms/tree/main', tag: '3.0.0' })).toContain('names no repository');
    expect(namedRepositoryProblem({ url: 'ms', tag: '3.0.0' })).toBe('"ms" is not a URL');
    for (const tag of ['../../main', 'a//b', '-flag', 'v1.lock', 'v1/', '', 'v1 v2']) {
      expect(namedRepositoryProblem({ url: 'https://github.com/vercel/ms', tag })).toBe(`${JSON.stringify(tag)} is not a tag a fetch can download`);
    }
  });
});

describe('fetchNamedRepository', () => {
  it("downloads the tag's archive from GitHub's own download host and untars it read-only, labelled weaker than pinned source", async () => {
    const bytes = tagArchive();
    const transport = recordedFetch({ [GITHUB_ARCHIVE]: bytes });

    const fetched = await fetchNamedRepository('ms', { url: 'https://github.com/vercel/ms.git', tag: '3.0.0' }, { librariesDir, fetch: transport.fetch });

    expect(fetched).toEqual({
      file: 'ms-3.0.0.tar.gz',
      sha256: sha256Hex(bytes),
      archive: 'named repository',
      note:
        'Fetched from https://github.com/vercel/ms at tag 3.0.0, which the agent named for ms: nothing in the head copy pins it, and nothing ties ' +
        'that tag to the version the project uses, so this is a named repository, weaker evidence than pinned source.',
      path: expect.stringContaining(join(librariesDir, 'repository-ms-3.0.0-')),
      reused: false,
    });
    expect(readFileSync(join(fetched.path, 'src', 'index.ts'), 'utf8')).toBe(INDEX);
    expect(statSync(join(fetched.path, 'scripts', 'postinstall.sh')).mode & 0o777).toBe(0o444);
    expect(readdirSync(fetched.path).sort()).toEqual(['scripts', 'src']);
    expect(transport.requests.map((request) => request.url)).toEqual([GITHUB_ARCHIVE]);
    expect(transport.requests[0]!.authorization).toBeNull();
  });

  it('reuses an earlier fetch of the same tag, and downloads a GitLab tag from gitlab.com', async () => {
    const bytes = tagArchive();
    const gitlab = 'https://gitlab.com/group/ms/-/archive/release/3.0/ms-release-3.0.tar.gz';
    const transport = recordedFetch({ [GITHUB_ARCHIVE]: bytes, [gitlab]: bytes });
    const first = await fetchNamedRepository('ms', { url: 'https://github.com/vercel/ms', tag: '3.0.0' }, { librariesDir, fetch: transport.fetch });

    const second = await fetchNamedRepository('ms', { url: 'https://github.com/vercel/ms', tag: '3.0.0' }, { librariesDir, fetch: transport.fetch });
    const other = await fetchNamedRepository('ms', { url: 'https://gitlab.com/group/ms', tag: 'release/3.0' }, { librariesDir, fetch: transport.fetch });

    expect(second).toEqual({ ...first, reused: true });
    expect(other).toMatchObject({ file: 'ms-release-3.0.tar.gz', reused: false });
    expect(transport.requests.map((request) => request.url)).toEqual([GITHUB_ARCHIVE, gitlab]);
  });

  it('says plainly when the tag is missing, and downloads nothing from a repository it refuses', async () => {
    const transport = recordedFetch({ [GITHUB_ARCHIVE]: 404 });

    await expect(fetchNamedRepository('ms', { url: 'https://github.com/vercel/ms', tag: '3.0.0' }, { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      'https://github.com/vercel/ms has no tag 3.0.0; nothing was downloaded',
    );
    await expect(fetchNamedRepository('ms', { url: 'https://evil.example/vercel/ms', tag: '3.0.0' }, { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      'the repository named for ms cannot be fetched: https://evil.example is not one of the hosts a named repository is fetched from (github.com, gitlab.com), over https; nothing was downloaded',
    );
    expect(transport.requests).toHaveLength(1);
  });
});
