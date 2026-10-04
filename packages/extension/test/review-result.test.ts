import { describe, expect, it } from 'vitest';
import { REVIEW_RESULT_VERSION, type NoiseAssessment, type ReviewResult } from '@second-look/engine';
import { ProtocolError, isReviewResult, parseReviewResult } from '../src/index.js';
import { claimsResult, judgedResult } from './results.js';

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
        name: 'Settings.load in src/settings.ts',
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
            entities: [
              { kind: 'method', name: 'Settings.load', public: true, change: 'declaration' },
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
        syntax: {
          language: 'typescript',
          formattingOnly: {
            status: 'structure-changed',
            reason: 'the syntax tree changes at head line 3',
          },
          checksNotRun: [],
        },
        signals: {
          novelty: 'changed',
          role: 'code',
          changedLines: 2,
          publicSurface: ['Settings.load'],
          references: { basis: 'name-based', names: ['load'], files: 3 },
        },
      },
    ],
    grouping: { by: 'plain' },
    ranking: { by: 'plain' },
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
    expect(isReviewResult({ version: 3 })).toBe(false);
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
      {
        label: 'lockfile',
        rule: 'lockfile-follows-manifest',
        state: 'confirmed',
        blindSpot: 'Parse-only: the resolver is not re-run.',
      },
      {
        label: 'lockfile',
        rule: 'lockfile-unexplained',
        state: 'claimed',
        blindSpot: 'Entries the manifest change does not explain: left-pad@2.0.0.',
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

  it('rejects a part without its name or signals', () => {
    for (const field of ['name', 'signals']) {
      const value = JSON.parse(JSON.stringify(sampleResult())) as {
        parts: Record<string, unknown>[];
      };
      delete value.parts[0]![field];
      expect(isReviewResult(value), field).toBe(false);
    }
  });

  it('rejects a reference count not labelled name-based', () => {
    const basis = JSON.parse(JSON.stringify(sampleResult())) as {
      parts: { signals: { references: { basis: string } } }[];
    };
    basis.parts[0]!.signals.references.basis = 'resolved';
    expect(isReviewResult(basis)).toBe(false);
  });

  it('rejects an entity without its visibility or change', () => {
    for (const field of ['public', 'change']) {
      const value = JSON.parse(JSON.stringify(sampleResult())) as {
        parts: { hunks: { entities: Record<string, unknown>[] }[] }[];
      };
      delete value.parts[0]!.hunks[0]!.entities[0]![field];
      expect(isReviewResult(value), field).toBe(false);
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

describe('isReviewResult for the agent grouping', () => {
  type Loose = { parts: Record<string, unknown>[]; grouping?: unknown };
  const loose = (): Loose => JSON.parse(JSON.stringify(sampleResult())) as Loose;
  const stamp = { agent: 'pi', agentVersion: '0.86.1', model: null, effort: null, runAt: '2026-10-02T00:00:00.000Z' };

  it('accepts a part across files with its origin, and an agent grouping with its stamp', () => {
    const value = loose();
    const { name: _name, signals: _signals, ...file } = value.parts[0]!;
    value.parts[0] = { ...value.parts[0], origin: 'agent', otherFiles: [{ ...file, path: 'src/other.ts' }] };
    value.grouping = {
      by: 'agent',
      agent: { promptVersion: '1', outcome: 'grouped', detail: 'every hunk was placed by the agent', leftOut: 0, stamp },
    };
    expect(isReviewResult(value)).toBe(true);
  });

  it('rejects an unknown origin, a malformed further file, and a missing or malformed grouping', () => {
    const origin = loose();
    origin.parts[0]!['origin'] = 'guessed';
    const otherFiles = loose();
    otherFiles.parts[0]!['otherFiles'] = [{ path: 'src/other.ts' }];
    const missing = loose();
    delete missing.grouping;
    const agentWithoutOutcome = loose();
    agentWithoutOutcome.grouping = { by: 'agent' };
    const unstamped = loose();
    unstamped.grouping = {
      by: 'plain',
      agent: { promptVersion: '1', outcome: 'fell back', detail: 'timeout', leftOut: 0, stamp: {} },
    };
    for (const value of [origin, otherFiles, missing, agentWithoutOutcome, unstamped]) {
      expect(isReviewResult(value)).toBe(false);
    }
  });
});

describe('isReviewResult for the agent ranking', () => {
  type Loose = { ranking?: unknown };
  const loose = (ranking: unknown): Loose => ({ ...(JSON.parse(JSON.stringify(sampleResult())) as Loose), ranking });
  const stamp = { agent: 'pi', agentVersion: '0.86.1', model: 'zai/glm-4.6', effort: null, runAt: '2026-10-04T00:00:00.000Z' };
  const agent = { promptVersion: '1', outcome: 'ranked', detail: 'accepted', stamp };

  it("accepts the agent's ranking with its stamp, and the plain ranking with why it stayed, stamped or not", () => {
    for (const ranking of [
      { by: 'agent', agent },
      { by: 'plain', agent: { ...agent, outcome: 'fell back' } },
      { by: 'plain', agent: { promptVersion: '1', outcome: 'not tested', detail: 'pi has none' } },
    ]) {
      expect(isReviewResult(loose(ranking))).toBe(true);
    }
  });

  it("rejects a missing ranking, an agent ranking shown unstamped or unranked, and a plain one claiming the agent's", () => {
    const { stamp: _stamp, ...unstamped } = agent;
    for (const ranking of [
      undefined,
      { by: 'agent' },
      { by: 'agent', agent: unstamped },
      { by: 'agent', agent: { ...agent, outcome: 'fell back' } },
      { by: 'plain', agent },
      { by: 'plain', agent: { ...agent, outcome: 'guessed' } },
    ]) {
      expect(isReviewResult(loose(ranking))).toBe(false);
    }
  });
});

describe('isReviewResult for the claims', () => {
  type Loose = { claims?: unknown; story?: unknown };
  const loose = (claims: unknown): Loose => ({ ...(JSON.parse(JSON.stringify(claimsResult())) as Loose), claims });
  const listed = (): { outcome: string; claims: Record<string, unknown>[] } & Record<string, unknown> =>
    JSON.parse(JSON.stringify(claimsResult().claims)) as { outcome: string; claims: Record<string, unknown>[] } & Record<string, unknown>;

  it('accepts the listed claims, none, and a fall back with none, always stamped', () => {
    expect(isReviewResult(claimsResult())).toBe(true);
    expect(isReviewResult(loose({ ...listed(), claims: [] }))).toBe(true);
    expect(isReviewResult(loose({ ...listed(), outcome: 'fell back', claims: [] }))).toBe(true);
    expect(isReviewResult(loose(undefined))).toBe(true);
  });

  it('rejects a claim without its quote, source or location, on a part or sentence the result lacks, or already judged', () => {
    const withClaim = (change: (claim: Record<string, unknown>) => Record<string, unknown>, index = 1): Loose => {
      const claims = listed();
      claims.claims[index] = change(claims.claims[index]!);
      return loose(claims);
    };
    const cases: Loose[] = [
      withClaim((claim) => ({ ...claim, quote: '' })),
      withClaim((claim) => ({ ...claim, source: 'issue' })),
      withClaim(({ location: _location, ...claim }) => claim),
      withClaim((claim) => ({ ...claim, location: { kind: 'file', path: 'src/retry.py', line: 4, endLine: 3 } })),
      withClaim((claim) => ({ ...claim, location: { kind: 'file', path: '', line: 1, endLine: 1 } })),
      withClaim((claim) => ({ ...claim, location: { kind: 'description', line: 0 } })),
      withClaim((claim) => ({ ...claim, location: { kind: 'story', sentence: 0 } })),
      withClaim((claim) => ({ ...claim, location: { kind: 'file', path: 'src/retry.py', line: 1, endLine: 1 } }), 3),
      withClaim((claim) => ({ ...claim, location: { kind: 'story', sentence: 2 } }), 3),
      withClaim((claim) => ({ ...claim, part: 7 })),
      withClaim((claim) => ({ ...claim, verdict: { kind: 'verified' } })),
      loose({ ...listed(), outcome: 'fell back' }),
      loose({ ...listed(), outcome: 'guessed' }),
      loose({ ...listed(), stamp: {} }),
      { ...loose(listed()), story: undefined },
    ];
    for (const value of cases) expect(isReviewResult(value)).toBe(false);
  });
});

describe('isReviewResult for the verdicts', () => {
  type Loose = { claims: { judging?: unknown; claims: Record<string, unknown>[] } };
  const judged = (): Loose => JSON.parse(JSON.stringify(judgedResult())) as Loose;
  const withVerdict = (verdict: unknown, index = 1): Loose => {
    const value = judged();
    value.claims.claims[index]!['verdict'] = verdict;
    return value;
  };
  const refuted = { kind: 'refuted', source: 'the change itself', reason: 'r', evidence: [{ path: 'src/retry.py', line: 6, quote: 'for attempt in range(5):' }] };

  it('accepts judged claims, each verdict with its evidence source, and a judging that fell back with every claim not checked', () => {
    expect(isReviewResult(judgedResult())).toBe(true);
    const fellBack = JSON.parse(JSON.stringify(claimsResult())) as Loose;
    fellBack.claims.judging = { ...judged().claims.judging as object, outcome: 'fell back' };
    expect(isReviewResult(fellBack)).toBe(true);
  });

  it("rejects a verdict without its source or reason, verified from the model's memory, citing a bad line, or checked before any judging", () => {
    const unjudged = judged();
    delete unjudged.claims.judging;
    const fellBack = judged();
    fellBack.claims.judging = { ...fellBack.claims.judging as object, outcome: 'fell back' };
    const cases: unknown[] = [
      withVerdict({ ...refuted, source: undefined }),
      withVerdict({ ...refuted, source: 'a hunch' }),
      withVerdict({ ...refuted, reason: undefined }),
      withVerdict({ ...refuted, kind: 'probably' }),
      withVerdict({ ...refuted, kind: 'verified', source: "the model's memory", evidence: [] }),
      withVerdict({ ...refuted, kind: 'refuted', source: "the model's memory" }),
      withVerdict({ ...refuted, evidence: [{ path: 'src/retry.py', line: 0, quote: 'x' }] }),
      withVerdict({ ...refuted, evidence: [{ path: '', line: 1, quote: 'x' }] }),
      withVerdict({ ...refuted, needsLibrary: 7 }),
      unjudged,
      fellBack,
      { ...judged(), claims: { ...judged().claims, judging: { outcome: 'judged' } } },
    ];
    for (const value of cases) expect(isReviewResult(value)).toBe(false);
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
    expect(REVIEW_RESULT_VERSION).toBe(8);
  });
});
