import { beforeEach, describe, expect, it } from 'vitest';
import type { ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import { FINDINGS_CONTROLLER_ID, FINDING_THREAD_CONTEXT } from '../src/commands.js';
import { FindingThreads, escapeMarkdown, findingBody } from '../src/findings.js';
import { claimsResult, fetchedResult, judgedResult, offeredResult, pipelineResult } from './results.js';
import { StubMarkdownString, stub, type StubCommentController } from './vscode-stub.js';

/** The findings' own controller, beside any other the companion made. */
function controller(): StubCommentController {
  return stub.commentControllers.find((each) => each.id === FINDINGS_CONTROLLER_ID)!;
}

function headUri(result: ReviewResult, path: string): string {
  return changeUri('head', result.copies.head.commit, path).toString();
}

describe('FindingThreads', () => {
  beforeEach(() => {
    stub.reset();
  });

  it("shows each refuted or unverifiable claim as the companion's own read-only thread at the cited location", () => {
    const result = judgedResult();
    new FindingThreads().show(result);

    const threads = controller().threads;
    expect(controller().label).toBe('Second Look findings');
    expect(controller().commentingRangeProvider).toBeUndefined();
    expect(threads.map((thread) => [thread.uri.toString(), thread.range?.start.line, thread.label])).toEqual([
      [headUri(result, 'src/retry.py'), 2, 'Refuted claim'],
      [headUri(result, 'src/retry.py'), 8, 'Unverifiable claim'],
      [headUri(result, 'src/settings.ts'), undefined, 'Unverifiable claim'],
    ]);
    for (const thread of threads) {
      expect(thread.canReply).toBe(false);
      expect(thread.contextValue).toBe(FINDING_THREAD_CONTEXT);
      expect(thread.comments[0]!.author.name).toBe('Second Look');
    }
    expect((threads[0]!.comments[0]!.body as StubMarkdownString).value).toContain('**Refuted** · evidence source: the change itself');
  });

  it('puts a refuted description claim on the first line its verdict cites', () => {
    const shown = judgedResult();
    const [description] = shown.claims!.claims;
    const refuted: ReviewResult = {
      ...shown,
      claims: {
        ...shown.claims!,
        claims: [{ ...description!, verdict: { kind: 'refuted', source: 'the change itself', reason: 'r', evidence: [{ path: 'src/settings.ts', line: 12, quote: 'RETRIES = 5' }] } }],
      },
    };
    new FindingThreads().show(refuted);

    expect(controller().threads.map((thread) => [thread.uri.toString(), thread.range?.start.line])).toEqual([[headUri(refuted, 'src/settings.ts'), 11]]);
  });

  it('replaces the threads of an earlier result, and shows none for claims not checked', () => {
    const findings = new FindingThreads();
    findings.show(judgedResult());
    findings.show(claimsResult());
    expect(controller().threads).toEqual([]);

    findings.show(judgedResult());
    findings.dispose();
    expect(stub.commentControllers.some((each) => each.id === FINDINGS_CONTROLLER_ID)).toBe(false);
  });
});

describe('the pipeline and CI on the findings', () => {
  it("labels a CI log's citation as one, and says the claim was the pipeline's", () => {
    const [pipeline] = pipelineResult().claims!.claims;
    const refuted = { ...pipeline!, verdict: { ...pipeline!.verdict, kind: 'refuted' } } as typeof pipeline & object;
    const body = findingBody(refuted);
    expect(body).toContain('**Refuted** · evidence source: a CI log');
    expect(body).toContain('- CI log of check / test, line 2 — FAILED test\\_retry\\.py::test\\_gives\\_up \\- assert 5 == 3');
    expect(body).toContain('Claim made in pipeline report, Review step · src/retry\\.py:6.');
    // The finding's text is someone else's, so its markup is escaped.
    expect(body).toContain('> send gives up after \\<b\\>five\\</b\\> attempts\\.');
  });

  it('puts a pipeline finding on the line it names', () => {
    stub.reset();
    const shown = pipelineResult();
    const [pipeline] = shown.claims!.claims;
    const refuted: ReviewResult = {
      ...shown,
      claims: { ...shown.claims!, claims: [{ ...pipeline!, verdict: { kind: 'refuted', source: 'a CI log', reason: 'r', evidence: [{ path: 'check / test', line: 2, quote: 'FAILED', ciLog: true }] } }] },
    };
    new FindingThreads().show(refuted);
    expect(controller().threads.map((thread) => [thread.uri.toString(), thread.range?.start.line])).toEqual([[headUri(refuted, 'src/retry.py'), 5]]);
  });
});

describe('findingBody', () => {
  it('gives the verdict, its evidence source, the quote, the reason, the citations and where the claim is made', () => {
    const [, docstring, comment, story] = judgedResult().claims!.claims;

    expect(findingBody(docstring!)).toBe(
      [
        '**Refuted** · evidence source: the change itself',
        '',
        '> Gives up after three attempts, whatever the status\\.',
        '',
        'The loop runs five times\\.',
        '',
        'Evidence:',
        '- src/retry\\.py:6 — for attempt in range\\(5\\):',
        '',
        'Claim made in docstring · src/retry\\.py:3–4.',
      ].join('\n'),
    );
    expect(findingBody(comment!)).toContain('Needs the source of requests, which the companion does not have.');
    expect(findingBody(story!)).toContain("**Unverifiable** · evidence source: the model's memory");
    expect(findingBody(story!)).toContain("Dropped to unverifiable: the model's memory never yields verified.");
  });

  it('offers the library fetch with its reason, as a link the reviewer presses, instead of saying the library is missing', () => {
    const offered = offeredResult().claims!.claims[2]!;

    const body = findingBody(offered, 2);

    expect(body).toContain('checking it needs the source of requests 2\\.32\\.3, as requirements\\.txt pins it\\.');
    expect(body).toContain(`[Fetch requests 2\\.32\\.3](command:second-look.fetchLibrary?${encodeURIComponent('[2]')}) — downloads only when pressed.`);
    expect(body).not.toContain('which the companion does not have');
  });

  it('names the library source a verdict was judged against, each citation a link that opens it', () => {
    const fetched = fetchedResult().claims!.claims[2]!;

    const body = findingBody(fetched, 2);

    expect(body).toContain('**Refuted** · evidence source: library source at the pinned version');
    expect(body).toContain(
      `- [requests/models\\.py:1021](command:second-look.openLibraryEvidence?${encodeURIComponent('[2,0]')}) — if 400 \\<= self\\.status\\_code \\< 500:`,
    );
    expect(body).toContain(
      'Judged against the source of requests 2\\.32\\.3, as requirements\\.txt pins it: requests\\-2\\.32\\.3\\-py3\\-none\\-any\\.whl, its SHA-256 checked, unpacked read-only and never run.',
    );
    expect(body).not.toContain('command:second-look.fetchLibrary');
  });

  it("names a NuGet package's checked SHA-512, and labels each citation of an unproven file", () => {
    const claim = fetchedResult().claims!.claims[2]!;
    const verdict = claim.verdict as Exclude<typeof claim.verdict, { kind: 'not checked' }>;
    const nuget = {
      ...claim,
      verdict: {
        ...verdict,
        evidence: [
          { path: 'src/RecyclableMemoryStream.cs', line: 490, quote: 'The buffer may be longer than the stream length.' },
          { path: 'src/./Events.cs', line: 2, quote: 'Copyright (c) 2015 Microsoft' },
        ],
        library: { ...verdict.library!, file: 'microsoft.io.recyclablememorystream.3.0.1.nupkg', archive: 'NuGet package' as const, unproven: ['src/RecyclableMemoryStream.cs', 'src/Events.cs'] },
      },
    };

    const body = findingBody(nuget, 2);

    expect(body).toContain(
      `- [src/RecyclableMemoryStream\\.cs:490](command:second-look.openLibraryEvidence?${encodeURIComponent('[2,0]')}) (unproven) — The buffer may be longer than the stream length\\.`,
    );
    expect(body).toContain(
      `- [src/\\./Events\\.cs:2](command:second-look.openLibraryEvidence?${encodeURIComponent('[2,1]')}) (unproven) — Copyright \\(c\\) 2015 Microsoft`,
    );
    expect(body).toContain('microsoft\\.io\\.recyclablememorystream\\.3\\.0\\.1\\.nupkg, its SHA-512 checked and never built or run, its source files fetched read-only at the commit it was built from.');
    expect(body).toContain('Unproven, so never verified: src/RecyclableMemoryStream\\.cs, src/Events\\.cs.');
  });

  it("names how each ecosystem's archive was checked", () => {
    const claim = fetchedResult().claims!.claims[2]!;
    const verdict = claim.verdict as Exclude<typeof claim.verdict, { kind: 'not checked' }>;
    const judged = (archive: 'npm package' | 'crate' | 'Go module' | 'sources jar', file: string) =>
      findingBody({ ...claim, verdict: { ...verdict, library: { ...verdict.library!, file, archive } } }, 2);

    expect(judged('npm package', 'ms-2.1.3.tgz')).toContain('ms\\-2\\.1\\.3\\.tgz, its SHA-512 checked, unpacked read-only and never run.');
    expect(judged('crate', 'cfg-if-1.0.0.crate')).toContain(', its SHA-256 checked, unpacked read-only and never built or run.');
    expect(judged('Go module', 'v0.9.1.zip')).toContain(', its go.sum hash checked, unpacked read-only and never built or run.');
    expect(judged('sources jar', 'slf4j-api-2.0.13-sources.jar')).toContain(", its SHA-1 checked against Maven Central's record, unpacked read-only and never built or run.");
  });

  it('offers a decompile by its own link, and labels every citation and verdict from decompiled code decompiled', () => {
    const offeredClaim = offeredResult().claims!.claims[2]!;
    const offeredVerdict = offeredClaim.verdict as Exclude<typeof offeredClaim.verdict, { kind: 'not checked' }>;
    const offer = { ...offeredVerdict.libraryFetch!, reason: 'No exact source of requests 2.32.3 exists.', decompile: { licence: 'MIT' } };

    const offering = findingBody({ ...offeredClaim, verdict: { ...offeredVerdict, libraryFetch: offer } }, 2);
    expect(offering).toContain('No exact source of requests 2\\.32\\.3 exists\\.');
    expect(offering).toContain(
      `[Decompile requests 2\\.32\\.3](command:second-look.fetchLibrary?${encodeURIComponent('[2]')}) — decompiles only when pressed, with the decompiler you installed.`,
    );

    const claim = fetchedResult().claims!.claims[2]!;
    const verdict = claim.verdict as Exclude<typeof claim.verdict, { kind: 'not checked' }>;
    const body = findingBody(
      { ...claim, verdict: { ...verdict, source: 'decompiled library code', libraryFetch: offer, library: { ...verdict.library!, file: 'requests.2.32.3.nupkg', archive: 'decompiled NuGet package', note: "Decompiled, not the library's source." } } },
      2,
    );

    expect(body).toContain('**Refuted** · evidence source: decompiled library code');
    expect(body).toMatch(/\(command:second-look\.openLibraryEvidence\?[^)]*\) \(decompiled\) — /);
    expect(body).toContain('Judged against code decompiled from requests 2\\.32\\.3, as requirements\\.txt pins it: decompiled, not its source. requests\\.2\\.32\\.3\\.nupkg had its SHA-512 checked');
    expect(body).toContain("Decompiled, not the library's source\\.");
  });

  it('offers a named repository by its URL and tag, and labels a verdict judged in one weaker than pinned source', () => {
    const named = { url: 'https://github.com/psf/requests', tag: 'v2.32.3' };
    const offeredClaim = offeredResult().claims!.claims[2]!;
    const offeredVerdict = offeredClaim.verdict as Exclude<typeof offeredClaim.verdict, { kind: 'not checked' }>;
    const offer = { ...offeredVerdict.libraryFetch!, pinnedVersion: named.tag, pinnedBy: named.url, namedRepository: named };

    expect(findingBody({ ...offeredClaim, verdict: { ...offeredVerdict, libraryFetch: offer } }, 2)).toContain(
      `[Fetch https://github\\.com/psf/requests at tag v2\\.32\\.3](command:second-look.fetchLibrary?${encodeURIComponent('[2]')}) — downloads only when pressed.`,
    );

    const claim = fetchedResult().claims!.claims[2]!;
    const verdict = claim.verdict as Exclude<typeof claim.verdict, { kind: 'not checked' }>;
    const body = findingBody(
      {
        ...claim,
        verdict: {
          ...verdict,
          source: 'a named repository',
          libraryFetch: offer,
          library: { ...verdict.library!, pinnedVersion: named.tag, pinnedBy: named.url, file: 'requests-v2.32.3.tar.gz', archive: 'named repository' },
        },
      },
      2,
    );

    expect(body).toContain('**Refuted** · evidence source: a named repository');
    expect(body).toContain(
      'Judged against requests in https://github\\.com/psf/requests at tag v2\\.32\\.3, which the agent named: a named repository, weaker evidence than pinned source, since nothing pins it.',
    );
  });

  it('says plainly why no library fetch is offered', () => {
    const comment = judgedResult().claims!.claims[2]!;
    const verdict = comment.verdict as Exclude<typeof comment.verdict, { kind: 'not checked' }>;
    const noLibraryFetch = 'No library fetch: nothing in the head copy pins requests so a fetch can check it, and the agent named no repository and tag for it.';

    const body = findingBody({ ...comment, verdict: { ...verdict, noLibraryFetch } });

    expect(body).toContain('Needs the source of requests, which the companion does not have.');
    expect(body).toContain(escapeMarkdown(noLibraryFetch));
  });

  it('trusts only the fetch and the open-evidence commands in a finding', () => {
    stub.reset();
    new FindingThreads().show(offeredResult());

    const body = controller().threads[1]!.comments[0]!.body as StubMarkdownString & { isTrusted?: unknown };
    expect(body.value).toContain('command:second-look.fetchLibrary');
    expect(body.isTrusted).toEqual({ enabledCommands: ['second-look.fetchLibrary', 'second-look.openLibraryEvidence'] });
  });

  it('escapes every quote and reason, so nothing someone else wrote renders as markup', () => {
    expect(escapeMarkdown('[click](https://evil.example) <img src=x> **bold** `code`')).toBe(
      '\\[click\\]\\(https://evil\\.example\\) \\<img src=x\\> \\*\\*bold\\*\\* \\`code\\`',
    );
  });
});
