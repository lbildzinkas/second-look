import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { CLAIMS_INSTRUCTIONS } from '../src/claims.js';
import {
  LIBRARY_VERDICTS_INSTRUCTIONS,
  LIBRARY_VERDICTS_PROMPT_VERSION,
  libraryVerdictPrompt,
  pressLibraryFetch,
} from '../src/library-verdicts.js';
import type { Claim, Part } from '../src/protocol.js';
import { reviewChange, type ReviewInput } from '../src/review.js';
import { VERDICTS_INSTRUCTIONS, findingAnchor } from '../src/verdicts.js';
import { answeringAgent, changedPart, pypiFetch, scriptedAgent, sha256Hex, temporaryCacheDir, zipArchive } from './helpers.js';

const DOC_PAGE = [
  'def doc_page(client, url):',
  '    """Any redirect on the way is followed."""',
  '    response = client.get(url)',
  '    return response.text',
].join('\n');

const CLIENT = ['class Client:', '    def __init__(self, follow_redirects: bool = False):', '        self.follow_redirects = follow_redirects', ''].join('\n');

const WHEEL = zipArchive([{ name: 'httpx/_client.py', content: CLIENT }]);

const OFFER = {
  library: 'httpx',
  pinnedVersion: '0.27.2',
  pinnedBy: 'requirements.txt',
  reason: 'The change alone cannot settle this claim.',
};

function part(): Part {
  return { ...changedPart({ path: 'app/doc_links.py', head: DOC_PAGE, added: [1, 2, 3, 4] }), name: 'doc_page in app/doc_links.py' };
}

/** The docstring's claim, unverifiable from the change, with the fetch its verdict offers. */
function claim(location: Claim['location'] = { kind: 'file', path: 'app/doc_links.py', line: 2, endLine: 2 }): Claim {
  return {
    quote: 'Any redirect on the way is followed.',
    source: location.kind === 'file' ? 'docstring' : 'description',
    location,
    part: 0,
    verdict: {
      kind: 'unverifiable',
      source: 'the change itself',
      reason: 'Whether redirects are followed is up to httpx.',
      evidence: [],
      needsLibrary: 'httpx',
      libraryFetch: OFFER,
    },
  };
}

const REFUTED = {
  verdict: 'refuted',
  source: 'library source at the pinned version',
  reason: 'A client follows no redirect unless it is built with follow_redirects=True.',
  evidence: [{ file: 'httpx/_client.py', line: 2, quote: 'def __init__(self, follow_redirects: bool = False):' }],
};

let cacheDir: string;
let headRoot: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
  headRoot = mkdtempSync(join(tmpdir(), 'second-look-head-'));
  writeFileSync(join(headRoot, 'requirements.txt'), `httpx==0.27.2 --hash=sha256:${sha256Hex(WHEEL)}\n`);
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

function options(adapter: ReturnType<typeof answeringAgent>) {
  const transport = pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2-py3-none-any.whl', bytes: WHEEL }]);
  return { transport, options: { adapter, headRoot, librariesDir: join(cacheDir, 'libraries'), fetch: transport.fetch } };
}

describe('libraryVerdictPrompt', () => {
  it('names the library at its pinned version and marks the claim and the diff as untrusted', () => {
    const prompt = libraryVerdictPrompt(claim(), part(), OFFER, 'BLOCK');

    expect(prompt).toContain('Judge this claim against the source of httpx 0.27.2, as requirements.txt pins it.');
    expect(prompt).toContain('<untrusted-input id="BLOCK" source="claim">\nAny redirect on the way is followed.\n</untrusted-input id="BLOCK">');
    expect(prompt).toContain('+3:     response = client.get(url)');
  });
});

describe('pressLibraryFetch', () => {
  it("judges the claim again in the fetched library's read-only source, re-reading its citation there", async () => {
    const agent = answeringAgent(() => REFUTED);
    const { options: pressed } = options(agent);

    const judging = await pressLibraryFetch([part()], claim(), pressed);

    // The agent works in the same folder of the library cache the reviewer's navigation reads.
    const libraryPath = join(cacheDir, 'libraries', `httpx-0.27.2-${sha256Hex(WHEEL).slice(0, 12)}`);
    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0]!.root).toBe(libraryPath);
    expect(agent.requests[0]!.instructions).toBe(LIBRARY_VERDICTS_INSTRUCTIONS);
    expect(judging).toMatchObject({ outcome: 'judged' });
    expect(judging.claim.verdict).toEqual({
      kind: 'refuted',
      source: 'library source at the pinned version',
      reason: REFUTED.reason,
      evidence: [{ path: 'httpx/_client.py', line: 2, quote: 'def __init__(self, follow_redirects: bool = False):' }],
      libraryFetch: OFFER,
      library: {
        library: 'httpx',
        pinnedVersion: '0.27.2',
        pinnedBy: 'requirements.txt',
        file: 'httpx-0.27.2-py3-none-any.whl',
        sha256: sha256Hex(WHEEL),
        archive: 'wheel',
        path: libraryPath,
        promptVersion: LIBRARY_VERDICTS_PROMPT_VERSION,
        stamp: expect.objectContaining({ agent: 'fake', model: 'fake/model' }),
      },
    });
  });

  it("drops a citation the library's source does not hold to unverifiable", async () => {
    const agent = answeringAgent(() => ({ ...REFUTED, evidence: [{ file: 'httpx/_client.py', line: 1, quote: 'follow_redirects: bool = True' }] }));

    const judging = await pressLibraryFetch([part()], claim(), options(agent).options);

    expect(judging.claim.verdict).toMatchObject({
      kind: 'unverifiable',
      recheck: 'the quote of the citation httpx/_client.py:1 is not on that line',
    });
  });

  it('keeps the verdict and its offer when the agent gives no usable answer', async () => {
    const agent = scriptedAgent(['not json', 'still not json']);

    const judging = await pressLibraryFetch([part()], claim(), options(agent).options);

    expect(judging).toMatchObject({ outcome: 'fell back', claim: claim(), detail: expect.stringContaining('the agent gave no usable answer') });
  });

  it('refuses a claim that offers no fetch, without downloading anything', async () => {
    const plain = { ...claim(), verdict: { kind: 'not checked' as const } };
    const { transport, options: pressed } = options(answeringAgent(() => REFUTED));

    await expect(pressLibraryFetch([part()], plain, pressed)).rejects.toThrow('this claim offers no library fetch');
    expect(transport.requests).toEqual([]);
  });

  it("puts a description claim's finding on its part, never on a line of the library", async () => {
    const judging = await pressLibraryFetch([part()], claim({ kind: 'description', line: 1 }), options(answeringAgent(() => REFUTED)).options);

    expect(judging.claim.verdict).toMatchObject({ kind: 'refuted' });
    expect(findingAnchor(judging.claim)).toBeUndefined();
  });
});

describe('the Python canary', () => {
  const folder = fileURLToPath(new URL('../../evaluation/cases/canary-python/', import.meta.url));
  const REDIRECT = 'Any redirect on the way is followed, so the caller always receives the final page rather than a 3xx status.';

  /** Serves the canary's recorded PyPI answer and wheel from its `fetched` folder, by URL. */
  const recorded: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(await readFile(join(folder, 'fetched', url.host, ...url.pathname.split('/').filter(Boolean))));
  };

  it('offers the fetch with its reason, and turns refuted with a citation into httpx at the pinned version', async () => {
    const record = JSON.parse(await readFile(join(folder, 'case.json'), 'utf8')) as { pullRequest: ReviewInput['pullRequest'] };
    const input: ReviewInput = {
      pullRequest: record.pullRequest,
      diff: await readFile(join(folder, 'change.diff'), 'utf8'),
      gitAttributes: null,
      copies: { base: { commit: 'base', path: join(folder, 'base'), reused: true }, head: { commit: 'head', path: join(folder, 'head'), reused: true } },
    };
    const agent = answeringAgent((run) => {
      if (run.instructions === CLAIMS_INSTRUCTIONS) return { claims: [{ source: 'docstring', quote: REDIRECT, file: 'app/doc_links.py', line: 9, part: null }] };
      if (run.instructions === VERDICTS_INSTRUCTIONS) {
        return { verdicts: [{ id: 'c1', verdict: 'unverifiable', source: 'the change itself', reason: 'It turns on how httpx.Client.get treats redirects.', evidence: [], library: 'httpx' }] };
      }
      if (run.instructions === LIBRARY_VERDICTS_INSTRUCTIONS) {
        return {
          verdict: 'refuted',
          source: 'library source at the pinned version',
          reason: 'A Client is built with follow_redirects=False, so get returns the 3xx response.',
          evidence: [{ file: 'httpx/_client.py', line: 171, quote: 'follow_redirects: bool = False,' }],
        };
      }
      return {};
    });

    const result = await reviewChange(input, { adapter: agent });
    const [offered] = result.claims!.claims;
    const judging = await pressLibraryFetch(result.parts, offered!, { adapter: agent, headRoot: input.copies.head.path, librariesDir: join(cacheDir, 'libraries'), fetch: recorded });

    expect(offered!.verdict).toMatchObject({
      kind: 'unverifiable',
      libraryFetch: { library: 'httpx', pinnedVersion: '0.27.2', pinnedBy: 'requirements.txt', reason: expect.stringContaining('needs the source of httpx 0.27.2') },
    });
    expect(judging.claim.verdict).toMatchObject({
      kind: 'refuted',
      source: 'library source at the pinned version',
      evidence: [{ path: 'httpx/_client.py', line: 171, quote: 'follow_redirects: bool = False,' }],
      library: { file: 'httpx-0.27.2-py3-none-any.whl', sha256: '7bb2708e112d8fdd7829cd4243970f0c223274051cb35ee80c03301ee29a3df0', archive: 'wheel' },
    });
  });
});
