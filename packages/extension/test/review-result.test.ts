import { describe, expect, it } from 'vitest';
import { REVIEW_RESULT_VERSION, type ReviewResult } from '@second-look/engine';
import { ProtocolError, isReviewResult, parseReviewResult } from '../src/index.js';

function sampleResult(): ReviewResult {
  return {
    version: REVIEW_RESULT_VERSION,
    pullRequest: {
      url: 'https://github.com/example-org/example-repo/pull/42',
      number: 42,
      title: 'Update dependencies',
      author: 'reviewer-login',
      description: 'A description of any length, kept in full.',
      base: 'master',
      head: 'update-deps',
    },
    parts: [
      {
        path: 'src/settings.ts',
        previousPath: 'src/config.ts',
        changeKind: 'rename',
        isBinary: false,
        oldMode: '100644',
        newMode: '100644',
        oldMissingFinalNewline: false,
        newMissingFinalNewline: true,
        hunks: [
          {
            oldStart: 2,
            oldLines: 3,
            newStart: 2,
            newLines: 3,
            heading: 'Dependencies',
            lines: [
              { kind: 'context', oldLineNumber: 2, newLineNumber: 2, text: 'same' },
              {
                kind: 'deletion',
                oldLineNumber: 3,
                text: 'gone',
                endsWithoutNewline: true,
              },
              { kind: 'addition', newLineNumber: 3, text: 'here' },
            ],
          },
        ],
        additions: 1,
        deletions: 1,
      },
    ],
  };
}

describe('isReviewResult', () => {
  it('accepts a review result of the shared version', () => {
    expect(isReviewResult(sampleResult())).toBe(true);
    expect(isReviewResult(JSON.parse(JSON.stringify(sampleResult())))).toBe(true);
  });

  it('rejects results of any other version', () => {
    const value = sampleResult() as unknown as { version: number };
    value.version = 2;
    expect(isReviewResult(value)).toBe(false);
  });

  it('rejects values that are not review results', () => {
    expect(isReviewResult(null)).toBe(false);
    expect(isReviewResult('review')).toBe(false);
    expect(isReviewResult({ version: 1 })).toBe(false);
  });

  it('rejects a part with an unknown change kind', () => {
    const value = JSON.parse(JSON.stringify(sampleResult())) as {
      parts: { changeKind: string }[];
    };
    value.parts[0]!.changeKind = 'wholesale';
    expect(isReviewResult(value)).toBe(false);
  });

  it('accepts a part for a copied file', () => {
    const value = JSON.parse(JSON.stringify(sampleResult())) as {
      parts: { changeKind: string }[];
    };
    value.parts[0]!.changeKind = 'copy';
    expect(isReviewResult(value)).toBe(true);
  });

  it('rejects a part whose numbers are not integers', () => {
    const value = JSON.parse(JSON.stringify(sampleResult())) as {
      parts: { additions: number }[];
    };
    value.parts[0]!.additions = 1.5;
    expect(isReviewResult(value)).toBe(false);
  });
});

describe('parseReviewResult', () => {
  it('reads the JSON the engine printed', () => {
    const result = parseReviewResult(JSON.stringify(sampleResult()));
    expect(result.pullRequest.number).toBe(42);
    expect(result.parts[0]!.path).toBe('src/settings.ts');
  });

  it('throws a ProtocolError for anything else', () => {
    expect(() => parseReviewResult('{}')).toThrow(ProtocolError);
    expect(() => parseReviewResult('not json')).toThrow();
  });
});

describe('the versioned protocol is shared with the engine', () => {
  it('uses the same version constant', () => {
    expect(REVIEW_RESULT_VERSION).toBe(1);
  });
});
