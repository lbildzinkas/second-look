import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { draftChecks, MAX_DRAFT_LENGTH, type DraftFinding } from '@second-look/engine';
import { loadCases } from '../src/case.js';

const CASES = fileURLToPath(new URL('../cases', import.meta.url));

/**
 * A draft written by hand for one of the cases' findings, with what a
 * reviewer says of it: whether it cites the finding's evidence location,
 * whether it adds a claim the finding lacks, and whether it is short
 * enough. The plain checks must agree with every label before their
 * scores are trusted (ADR 0006).
 */
interface LabelledDraft {
  case: string;
  /** The finding, by its index in the case's drafts. */
  finding: number;
  comment: string;
  cites: boolean;
  addsClaim: boolean;
  short: boolean;
}

const LABELLED: readonly LabelledDraft[] = [
  {
    case: 'misstated-python',
    finding: 0,
    comment: 'The description says the fraction is padded on the right, but `src/tomli/_re.py:83` uses `rjust`, so `.5` parses as 5 microseconds, not 500000.',
    cites: true,
    addsClaim: false,
    short: true,
  },
  {
    case: 'misstated-python',
    finding: 0,
    comment: 'Use `ljust` at `src/tomli/_re.py:83` and add a test in `tests/test_datetime.py`.',
    cites: true,
    addsClaim: true,
    short: true,
  },
  {
    case: 'misstated-python',
    finding: 0,
    comment: 'This padding looks wrong to me.',
    cites: false,
    addsClaim: false,
    short: true,
  },
  {
    case: 'canary-python',
    finding: 0,
    comment: 'The docstring at `app/doc_links.py:9` says every redirect is followed. Whether `client.get` does depends on httpx; could you show where?',
    cites: true,
    addsClaim: false,
    short: true,
  },
  {
    case: 'canary-python',
    finding: 0,
    comment: 'The docstring at `app/doc_links.py:9` is wrong: httpx 0.28 stopped following redirects.',
    cites: true,
    addsClaim: true,
    short: true,
  },
  {
    case: 'canary-python',
    finding: 1,
    comment: "The docstring says redirects are followed, but httpx's `Client` defaults to `follow_redirects: bool = False,` (`httpx/_client.py:643`), so a 3xx comes back as is.",
    cites: true,
    addsClaim: false,
    short: true,
  },
  {
    case: 'canary-python',
    finding: 1,
    comment: `The docstring overstates it, see \`httpx/_client.py:643\`. ${'More detail. '.repeat(50)}`,
    cites: true,
    addsClaim: false,
    short: false,
  },
  {
    case: 'planted-click',
    finding: 0,
    comment: 'This change to `pause` in `src/click/termui.py` is not mentioned in the description or #2869. Could it go in its own pull request?',
    cites: true,
    addsClaim: false,
    short: true,
  },
  {
    case: 'planted-click',
    finding: 0,
    comment: 'Why does `pause` change here? It is not mentioned anywhere.',
    cites: false,
    addsClaim: false,
    short: true,
  },
  {
    case: 'planted-click',
    finding: 1,
    comment: 'The description promises an example in `docs/utils.md` that edits a `pathlib.Path`, but the diff does not change that file.',
    cites: true,
    addsClaim: false,
    short: true,
  },
  {
    case: 'planted-click',
    finding: 1,
    comment: 'The description promises a `docs/utils.md` example; it should go under `docs/api.md` line 40 too.',
    cites: true,
    addsClaim: true,
    short: true,
  },
  {
    case: 'criteria-python',
    finding: 0,
    comment: '#250 asks for the README\'s "Parse a TOML file" section to show loading a path, and the change does not touch the README.',
    cites: true,
    addsClaim: false,
    short: true,
  },
  {
    case: 'criteria-python',
    finding: 1,
    comment: '#250 asks for `bytes` paths too, but `src/tomli/_parser.py:142` checks only `str` and `os.PathLike`. Is a `bytes` path meant to work?',
    cites: true,
    addsClaim: false,
    short: true,
  },
  {
    case: 'criteria-python',
    finding: 1,
    comment: 'A `bytes` path fails: wrap it in `os.fsdecode` before `open`.',
    cites: false,
    addsClaim: true,
    short: true,
  },
];

describe('the draft checks against hand labels', () => {
  it('agree with every hand label on the hand-written drafts of the cases\' findings', async () => {
    const cases = new Map((await loadCases([CASES])).map((each) => [each.id, each]));
    const disagreements: string[] = [];
    for (const labelled of LABELLED) {
      const finding: DraftFinding | undefined = cases.get(labelled.case)?.expected.drafts?.[labelled.finding];
      expect(finding, `${labelled.case} finding ${labelled.finding}`).toBeDefined();
      const checks = draftChecks(finding!, labelled.comment);
      const got = { cites: checks.cited.length > 0, addsClaim: checks.added.length > 0, short: checks.underCap };
      for (const label of ['cites', 'addsClaim', 'short'] as const) {
        if (got[label] !== labelled[label]) disagreements.push(`${labelled.case} #${labelled.finding} ${label}: labelled ${labelled[label]}, checked ${got[label]} (${checks.added.join(', ')})`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('label every check both ways, so agreement means something', () => {
    for (const label of ['cites', 'addsClaim', 'short'] as const) {
      expect(new Set(LABELLED.map((labelled) => labelled[label]))).toEqual(new Set([true, false]));
    }
    expect(LABELLED.filter((labelled) => !labelled.short).every((labelled) => labelled.comment.length > MAX_DRAFT_LENGTH)).toBe(true);
  });

  it('cover a finding of every kind the cases draft from', async () => {
    const cases = await loadCases([CASES]);
    const findings = cases.flatMap((each) => (each.expected.drafts ?? []).map((finding, index) => ({ case: each.id, index, kind: finding.kind })));
    expect(new Set(findings.map((finding) => finding.kind))).toEqual(
      new Set([
        'refuted claim',
        'unverifiable claim',
        'unexplained change',
        'described change the diff does not contain',
        'acceptance criterion not met',
        'acceptance criterion partly met',
      ]),
    );
    for (const finding of findings) {
      expect(LABELLED.some((labelled) => labelled.case === finding.case && labelled.finding === finding.index), `${finding.case} #${finding.index}`).toBe(true);
    }
    // Every case that drafts is tied to the draft-comment prompt.
    for (const each of cases) {
      expect(each.record.prompts.includes('draft-comment'), each.id).toBe(each.expected.drafts !== undefined);
    }
  });
});
