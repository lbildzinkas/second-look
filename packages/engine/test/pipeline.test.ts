import { describe, expect, it } from 'vitest';
import { pipelineClaims, readFindings, readPipelineReport } from '../src/pipeline.js';
import type { Part } from '../src/protocol.js';
import { changedPart } from './helpers.js';

const HEAD = 'f00dcafe1234567890abcdef1234567890abcdef';
const OLDER = 'e804c2eea15efa7a734a2247c8205d8229299252';

/** The attestation as the pipeline writes it, at the given head commit. */
function attestation(headSha: string): string {
  const steps = [
    { step: 'review', status: 'completed' },
    { step: 'pr', status: 'running' },
  ];
  return `<!-- no-mistakes-pipeline-attestation:v1 ${JSON.stringify({ head_sha: headSha, steps })} -->`;
}

/** A Pipeline section after the attestation, as a pull request's description carries it. */
const REPORT = [
  '<details>',
  '<summary>✅ **Rebase** - passed</summary>',
  '',
  '✅ No issues found.',
  '</details>',
  '',
  '<details>',
  '<summary>⚠️ **Review** - 2 warnings, 1 info</summary>',
  '',
  '- ⚠️ `src/settings.ts:12` - load() returns 3000 when the file sets 30 &#39;seconds&#39;.',
  '- ⚠️ `src/fresh.ts:3` - the helper drops the last entry.',
  '- ℹ️ The README still names the old module.',
  '',
  '🔧 Fix applied.',
  '2 warnings, 1 info still open:',
  '',
  '- ⚠️ `src/settings.ts:12` - load() returns 3000 when the file sets 30 &#39;seconds&#39;.',
  '- ℹ️ The README still names the old module.',
  '</details>',
  '',
  '<details>',
  '<summary>🔧 **Test** - 1 issue found → fix applied ✅</summary>',
  '',
  '- ❌ `src/legacy.ts:4` - the test of the legacy path fails.',
  '',
  '🔧 Fix applied.',
  '</details>',
  '',
  '<details>',
  '<summary>🔧 **Lint** - 1 issue found → no changes applied ✅</summary>',
  '',
  '- ❌ The lint step could not finish.',
  '- `npx eslint .`',
  '',
  '🔧 No changes applied.',
  '</details>',
].join('\n');

function description(headSha: string): string {
  return ['## Intent', '', 'Loads the settings.', '', '## Pipeline', '', attestation(headSha), '', REPORT].join('\n');
}

describe('readPipelineReport: the attestation freshness rule', () => {
  it('trusts a report whose head commit is the pull request\'s head, as fresh', () => {
    const report = readPipelineReport(description(HEAD), HEAD);
    expect(report.attestation).toBe('fresh');
    expect(report.headSha).toBe(HEAD);
    expect(report.detail).toContain("the pull request's head f00dcaf");
    expect(report.steps).toEqual([
      { step: 'review', status: 'completed' },
      { step: 'pr', status: 'running' },
    ]);
    // The head commit is matched whatever its case.
    expect(readPipelineReport(description(HEAD.toUpperCase()), HEAD).attestation).toBe('fresh');
  });

  it('shows a report made at another commit as stale, its findings kept but not trusted', () => {
    const report = readPipelineReport(description(OLDER), HEAD);
    expect(report.attestation).toBe('stale');
    expect(report.headSha).toBe(OLDER);
    expect(report.detail).toBe("the report was made at e804c2e, but the pull request's head is now f00dcaf: it is shown, not trusted");
    expect(report.findings).toHaveLength(3);
  });

  it('says so when the description carries no attestation', () => {
    expect(readPipelineReport('## Intent\n\nNo pipeline ran.', HEAD)).toEqual({
      attestation: 'missing',
      detail: 'the description carries no no-mistakes attestation',
      steps: [],
      findings: [],
    });
    // The words alone, outside the attestation's comment, are no attestation.
    expect(readPipelineReport('no-mistakes-pipeline-attestation:v1 {}', HEAD).attestation).toBe('missing');
  });

  it('marks an attestation it cannot read as malformed, naming why', () => {
    const malformed = (json: string): string => readPipelineReport(`<!-- no-mistakes-pipeline-attestation:v1 ${json} -->`, HEAD).detail;
    expect(malformed('{"head_sha": ')).toBe('the attestation cannot be read: its JSON does not parse');
    expect(malformed('[]')).toBe('the attestation cannot be read: its JSON is not an object');
    expect(malformed('{"head_sha": "f00dcaf", "steps": []}')).toBe('the attestation cannot be read: it names no full head commit');
    expect(malformed(`{"head_sha": "${HEAD}"}`)).toBe('the attestation cannot be read: it lists no steps');
    expect(malformed(`{"head_sha": "${HEAD}", "steps": [{"step": "review"}]}`)).toBe('the attestation cannot be read: a step has no name or status');
    const report = readPipelineReport(`<!-- no-mistakes-pipeline-attestation:v1 {"head_sha": -->\n${REPORT}`, HEAD);
    expect(report).toMatchObject({ attestation: 'malformed', steps: [] });
    expect(report.headSha).toBeUndefined();
  });

  it('reads the last attestation when the description carries several', () => {
    const both = `${attestation(OLDER)}\n${attestation(HEAD)}`;
    expect(readPipelineReport(both, HEAD).attestation).toBe('fresh');
    expect(readPipelineReport(`${attestation(HEAD)}\n${attestation(OLDER)}`, HEAD).attestation).toBe('stale');
  });
});

describe('readFindings', () => {
  it('keeps the findings each step leaves open, with their severity, file and line, as plain text', () => {
    expect(readFindings(REPORT)).toEqual([
      { step: 'Review', severity: 'warning', text: "load() returns 3000 when the file sets 30 'seconds'.", path: 'src/settings.ts', line: 12 },
      { step: 'Review', severity: 'info', text: 'The README still names the old module.' },
      // A step whose fix was applied leaves nothing open; one whose fix
      // applied no change keeps its findings, and a line with no severity
      // mark is no finding.
      { step: 'Lint', severity: 'error', text: 'The lint step could not finish.' },
    ]);
  });
});

describe('pipelineClaims', () => {
  const settings = (): Part => ({
    ...changedPart({ path: 'src/settings.ts', head: Array.from({ length: 14 }, (_, at) => `line ${at + 1}`).join('\n'), added: [10, 11, 12] }),
    name: 'load in src/settings.ts',
  });
  const fresh = (): Part => ({ ...changedPart({ path: 'src/fresh.ts', head: 'a\nb\nc', added: [1, 2, 3] }), name: 'src/fresh.ts' });

  it("lists a fresh report's open findings as claims, each on the part it names, not checked yet", () => {
    const parts = [fresh(), settings()];
    parts[1]!.hunks[0]!.newStart = 10;
    parts[1]!.hunks[0]!.newLines = 3;
    const claims = pipelineClaims(readPipelineReport(description(HEAD), HEAD), parts);
    expect(claims).toEqual([
      {
        quote: "load() returns 3000 when the file sets 30 'seconds'.",
        source: 'pipeline',
        location: { kind: 'pipeline', finding: 0, step: 'Review', path: 'src/settings.ts', line: 12 },
        part: 1,
        verdict: { kind: 'not checked' },
      },
      {
        quote: 'The README still names the old module.',
        source: 'pipeline',
        location: { kind: 'pipeline', finding: 1, step: 'Review' },
        // A finding about no file of the change is about the whole change: the first part.
        part: 0,
        verdict: { kind: 'not checked' },
      },
      {
        quote: 'The lint step could not finish.',
        source: 'pipeline',
        location: { kind: 'pipeline', finding: 2, step: 'Lint' },
        part: 0,
        verdict: { kind: 'not checked' },
      },
    ]);
  });

  it('lists no claim from a report that is stale, malformed or missing, or for a change with no parts', () => {
    const parts = [fresh(), settings()];
    expect(pipelineClaims(readPipelineReport(description(OLDER), HEAD), parts)).toEqual([]);
    expect(pipelineClaims(readPipelineReport(`<!-- no-mistakes-pipeline-attestation:v1 {} -->\n${REPORT}`, HEAD), parts)).toEqual([]);
    expect(pipelineClaims(readPipelineReport(REPORT, HEAD), parts)).toEqual([]);
    expect(pipelineClaims(readPipelineReport(description(HEAD), HEAD), [])).toEqual([]);
  });
});
