import { beforeEach, describe, expect, it } from 'vitest';
import type { ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import { FINDINGS_CONTROLLER_ID, FINDING_THREAD_CONTEXT } from '../src/commands.js';
import { FindingThreads, escapeMarkdown, findingBody } from '../src/findings.js';
import { claimsResult, judgedResult } from './results.js';
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

  it('escapes every quote and reason, so nothing someone else wrote renders as markup', () => {
    expect(escapeMarkdown('[click](https://evil.example) <img src=x> **bold** `code`')).toBe(
      '\\[click\\]\\(https://evil\\.example\\) \\<img src=x\\> \\*\\*bold\\*\\* \\`code\\`',
    );
  });
});
