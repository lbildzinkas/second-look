import { REVIEW_RESULT_VERSION, type NoiseAssessment, type Part, type ReviewResult } from '@second-look/engine';

/** The noise assessment every part carries: no rule applied. */
export const NO_RULE_APPLIED: NoiseAssessment = { label: 'none', note: 'no rule applied' };

/** A minimal well-formed part the tests shape further. */
export function part(path: string, overrides: Partial<Part> = {}): Part {
  return {
    path,
    changeKind: 'modification',
    isBinary: false,
    oldMissingFinalNewline: false,
    newMissingFinalNewline: false,
    hunks: [],
    additions: 1,
    deletions: 0,
    noise: NO_RULE_APPLIED,
    syntax: {
      formattingOnly: {
        status: 'not-checked',
        reason: 'the tests do not parse syntax trees',
      },
      checksNotRun: [
        { check: 'entities', reason: 'the tests do not parse syntax trees' },
        { check: 'formatting-only', reason: 'the tests do not parse syntax trees' },
      ],
    },
    ...overrides,
  };
}

/** A pull request summary the tests never vary. */
function summary() {
  return {
    url: 'https://github.com/example-org/example-repo/pull/42',
    number: 42,
    title: 'Retry failed webhook sends',
    author: 'reviewer-login',
    description: 'A description of any length, kept in full.',
    base: 'master',
    head: 'retry-webhooks',
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    headSha: 'f00dcafe1234567890abcdef1234567890abcdef12',
  };
}

export function result(parts: Part[]): ReviewResult {
  return {
    version: REVIEW_RESULT_VERSION,
    pullRequest: summary(),
    copies: {
      base: {
        commit: '0123456789abcdef0123456789abcdef01234567',
        path: '/cache/pull-42/0123456789abcdef0123456789abcdef01234567',
        reused: false,
      },
      head: {
        commit: 'f00dcafe1234567890abcdef1234567890abcdef12',
        path: '/cache/pull-42/f00dcafe1234567890abcdef1234567890abcdef12',
        reused: false,
      },
    },
    parseTimeMs: 0,
    parts,
  };
}

/** A ranked, labelled, and unranked mix that exercises the whole tree. */
export function mixedResult(): ReviewResult {
  return result([
    part('src/retry.py', {
      additions: 40,
      rank: {
        importance: 'must review',
        reason: 'New code the send path now runs on every delivery.',
        signals: ['new code', '2 callers', 'no tests before this pull request'],
      },
    }),
    part('src/settings.ts', {
      rank: {
        importance: 'worth reviewing',
        reason: 'Changed code that the retry policy reads.',
        signals: ['changed code'],
      },
    }),
    part('CHANGELOG.md', {
      rank: {
        importance: 'context',
        reason: 'Release note only.',
        signals: ['documentation only'],
      },
    }),
    part('src/legacy.ts'),
    part('__tests__/retry.test.ts.snap', {
      additions: 12,
      noise: {
        label: 'snapshot',
        rule: 'snapshot-name',
        state: 'claimed',
        blindSpot: 'Only known snapshot names are matched.',
      },
    }),
    part('uv.lock', {
      additions: 14,
      deletions: 9,
      noise: {
        label: 'lockfile',
        rule: 'lockfile-name',
        state: 'claimed',
        blindSpot: 'Only known lockfile names are matched.',
      },
    }),
    part('transport.py', {
      additions: 0,
      deletions: 0,
      noise: {
        label: 'moved or renamed',
        rule: 'rename-identical',
        state: 'confirmed',
        blindSpot: 'Identical content proves only the move.',
      },
    }),
  ]);
}
