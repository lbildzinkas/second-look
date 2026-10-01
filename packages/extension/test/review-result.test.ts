import { describe, expect, it } from 'vitest';
import { REVIEW_RESULT_VERSION, type NoiseAssessment, type ReviewResult } from '@second-look/engine';
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
      headSha: 'f00dcafe1234567890abcdef1234567890abcdef12',
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
        noise: {
          label: 'lockfile',
          rule: 'lockfile-name',
          state: 'claimed',
          blindSpot:
            'Only known lockfile names are matched; a lockfile renamed or hand-written under another name is missed.',
        },
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
    value.version = 3;
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

  it('accepts every noise label with its state and blind spot, and the none verdict', () => {
    const assessments: NoiseAssessment[] = [
      {
        label: 'moved or renamed',
        rule: 'rename-identical',
        state: 'confirmed',
        blindSpot: 'Identical content proves only the move.',
      },
      {
        label: 'snapshot',
        rule: 'snapshot-name',
        state: 'claimed',
        blindSpot: 'Only known snapshot names are matched.',
      },
      { label: 'none', note: 'no rule applied' },
    ];
    for (const noise of assessments) {
      const value = JSON.parse(JSON.stringify(sampleResult())) as {
        parts: { noise: NoiseAssessment }[];
      };
      value.parts[0]!.noise = noise;
      expect(isReviewResult(value), JSON.stringify(noise)).toBe(true);
    }
  });

  it('rejects a part whose noise assessment is missing or malformed', () => {
    const cases: unknown[] = [
      undefined,
      { label: 'none' }, // 'none' must say no rule applied
      { label: 'none', note: 'something else' },
      { label: 'mystery' }, // unknown label
      { label: 'lockfile', rule: 'lockfile-name', state: 'claimed' }, // no blind spot
      {
        label: 'lockfile',
        rule: 'lockfile-name',
        state: 'claimed',
        blindSpot: '', // the blind spot must say something
      },
      { label: 'lockfile', rule: 'made-up-rule', state: 'claimed', blindSpot: 'x' },
      { label: 'lockfile', rule: 'lockfile-name', state: 'proved', blindSpot: 'x' },
    ];
    for (const noise of cases) {
      const value = JSON.parse(JSON.stringify(sampleResult())) as {
        parts: Record<string, unknown>[];
      };
      if (noise === undefined) {
        delete value.parts[0]!['noise'];
      } else {
        value.parts[0]!['noise'] = noise;
      }
      expect(isReviewResult(value), JSON.stringify(noise)).toBe(false);
    }
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
    expect(REVIEW_RESULT_VERSION).toBe(2);
  });
});
