import { beforeEach, describe, expect, it } from 'vitest';
import type { ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import { FINDINGS_CONTROLLER_ID, FINDING_THREAD_CONTEXT } from '../src/commands.js';
import { FindingThreads, escapeMarkdown, findingBody } from '../src/findings.js';
import { claimsResult, fetchedResult, judgedResult, offeredResult } from './results.js';
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
