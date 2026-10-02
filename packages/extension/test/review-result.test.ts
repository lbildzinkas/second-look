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
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      headSha: 'f00dcafe1234567890abcdef1234567890abcdef',
    },
    copies: {
      base: {
        commit: '4242424242424242424242424242424242424242',
        path: '/cache/pull-42/4242424242424242424242424242424242424242',
        reused: false,
      },
      head: {
        commit: 'f00dcafe1234567890abcdef1234567890abcdef',
        path: '/cache/pull-42/f00dcafe1234567890abcdef1234567890abcdef',
        reused: true,
      },
    },
    parseTimeMs: 1.25,
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
            entities: [{ kind: 'method', name: 'Settings.load' }],
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
        syntax: {
          language: 'typescript',
          formattingOnly: {
            status: 'structure-changed',
            reason: 'the syntax tree changes at head line 3',
          },
          checksNotRun: [],
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

  it('rejects a summary missing the head commit SHA', () => {
    const value = JSON.parse(JSON.stringify(sampleResult())) as {
      pullRequest: Record<string, unknown>;
    };
    delete value.pullRequest['headSha'];
    expect(isReviewResult(value)).toBe(false);
  });

  it('rejects values that are not review results', () => {
    expect(isReviewResult(null)).toBe(false);
    expect(isReviewResult('review')).toBe(false);
    expect(isReviewResult({ version: 2 })).toBe(false);
  });

  it('rejects a part without its syntax findings', () => {
    const value = JSON.parse(JSON.stringify(sampleResult())) as {
      parts: { syntax?: unknown }[];
    };
    delete value.parts[0]!.syntax;
    expect(isReviewResult(value)).toBe(false);
  });

  it('rejects an unknown formatting-only status or entity kind', () => {
    const status = JSON.parse(JSON.stringify(sampleResult())) as {
      parts: { syntax: { formattingOnly: { status: string } } }[];
    };
    status.parts[0]!.syntax.formattingOnly.status = 'probably';
    expect(isReviewResult(status)).toBe(false);

    const entity = JSON.parse(JSON.stringify(sampleResult())) as {
      parts: { hunks: { entities: { kind: string }[] }[] }[];
    };
    entity.parts[0]!.hunks[0]!.entities[0]!.kind = 'widget';
    expect(isReviewResult(entity)).toBe(false);
  });

  it('rejects a result without its copies or parse time', () => {
    const noCopies = JSON.parse(JSON.stringify(sampleResult())) as { copies?: unknown };
    delete noCopies.copies;
    expect(isReviewResult(noCopies)).toBe(false);

    const noParseTime = JSON.parse(JSON.stringify(sampleResult())) as { parseTimeMs?: unknown };
    delete noParseTime.parseTimeMs;
    expect(isReviewResult(noParseTime)).toBe(false);
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

  it('accepts a part without a rank, until the engine ranks parts', () => {
    expect(sampleResult().parts[0]!.rank).toBeUndefined();
    expect(isReviewResult(sampleResult())).toBe(true);
  });

  it('accepts a part ranked with an importance, its reason and the signals the reason cites', () => {
    const value = JSON.parse(JSON.stringify(sampleResult())) as {
      parts: { rank: unknown }[];
    };
    value.parts[0]!.rank = {
      importance: 'must review',
      reason: 'New code the send path now runs on every delivery.',
      signals: ['new code', '2 callers'],
    };
    expect(isReviewResult(value)).toBe(true);
  });

  it('rejects a rank whose importance, reason or signals do not carry their shape', () => {
    const cases: unknown[] = [
      { importance: 'urgent', reason: 'Because.', signals: ['new code'] },
      { importance: 'must review', reason: '', signals: ['new code'] },
      { importance: 'must review', reason: 'Because.', signals: ['new code', ''] },
      { importance: 'must review', reason: 'Because.', signals: 'new code' },
      { importance: 'must review', reason: 'Because.' },
    ];
    for (const rank of cases) {
      const value = JSON.parse(JSON.stringify(sampleResult())) as {
        parts: { rank: unknown }[];
      };
      value.parts[0]!.rank = rank;
      expect(isReviewResult(value), JSON.stringify(rank)).toBe(false);
    }
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
