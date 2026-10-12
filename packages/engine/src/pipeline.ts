import { filesOfPart, lineInChange } from './parts.js';
import type { Claim, Part, PipelineFinding, PipelineReport, PipelineStep } from './protocol.js';

/**
 * The pipeline pass: reads the no-mistakes report a pull request's
 * description carries, model-free. The report is trusted only when its
 * attestation names the pull request's current head commit; a report made
 * at another commit is stale, and its findings are shown but never become
 * claims. Everything here was written into the description, by the
 * pipeline or by anyone who can edit it, so it stays untrusted text.
 */

/** The attestation the pipeline writes into the description: a marker, then its JSON, in an HTML comment. */
const ATTESTATION = /<!--\s*no-mistakes-pipeline-attestation:v1\s([\s\S]*?)-->/g;

/** A full commit SHA. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/** A step's report: an HTML details block whose summary names the step in bold. */
const DETAILS = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;

/** A finding's line in a step's report: a severity mark, then an optional `path:line`, then the text. */
const FINDING_LINE = /^\s*[-*]\s+(❌|⚠️|⚠|ℹ️|ℹ)\s+(?:`([^`\s]+):(\d+)`\s+-\s+)?(.+)$/u;

/** The line saying how many findings a step's round left still open. */
const STILL_OPEN = /^\s*\d+\s+.*\bstill open:\s*$/;

/** The line a round writes when it applied a fix; what follows it, its re-check, opens the next round or closes the step. */
const FIX_APPLIED = /^\s*🔧\s*Fix applied\.\s*$/u;

/** How the report's marks read as severities. */
const SEVERITIES: Record<string, PipelineFinding['severity']> = {
  '❌': 'error',
  '⚠️': 'warning',
  '⚠': 'warning',
  'ℹ️': 'info',
  ℹ: 'info',
};

/** The longest finding text a claim quotes. */
const MAX_FINDING_TEXT = 2000;

/** The entities the report escapes its text with, as GitHub renders them. */
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Text as the reader of the rendered report sees it, on one line. */
function plainText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]!).replace(/\s+/g, ' ').trim();
}

/** A short commit, as the reviewer reads one. */
function short(sha: string): string {
  return sha.slice(0, 7);
}

/** The last line matching `mark`, or -1 when none does. */
function lastMarked(lines: readonly string[], mark: RegExp): number {
  for (let at = lines.length - 1; at >= 0; at -= 1) if (mark.test(lines[at]!)) return at;
  return -1;
}

/** The attestation's steps, or why they cannot be read. */
function readSteps(value: unknown): PipelineStep[] | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'its JSON is not an object';
  const { head_sha: headSha, steps } = value as Record<string, unknown>;
  if (typeof headSha !== 'string' || !FULL_SHA.test(headSha)) return 'it names no full head commit';
  if (!Array.isArray(steps)) return 'it lists no steps';
  const read: PipelineStep[] = [];
  for (const each of steps) {
    const { step, status } = (typeof each === 'object' && each !== null ? each : {}) as Record<string, unknown>;
    if (typeof step !== 'string' || typeof status !== 'string') return 'a step has no name or status';
    read.push({ step, status });
  }
  return read;
}

/**
 * The findings each step's report leaves open: those of its last round
 * only — the finding lines after the last line saying how many are
 * still open, unless a fix was applied after that listing, which leaves
 * none. A step with neither listing nor fix lists every finding line,
 * and a finding repeated within the round read appears once.
 */
export function readFindings(section: string): PipelineFinding[] {
  const findings: PipelineFinding[] = [];
  for (const [, summary, body] of section.matchAll(DETAILS)) {
    const step = /\*\*([^*]+)\*\*/.exec(summary!)?.[1]?.trim() ?? plainText(summary!);
    const lines = body!.split('\n');
    const openAt = lastMarked(lines, STILL_OPEN);
    // A fix applied after the last listing resolved that round; its
    // re-check left nothing open.
    if (lastMarked(lines, FIX_APPLIED) > openAt) continue;
    const seen = new Set<string>();
    for (const line of lines.slice(openAt + 1)) {
      const match = FINDING_LINE.exec(line);
      if (!match) continue;
      const [, mark, path, lineNumber, text] = match;
      const at = Number(lineNumber);
      const finding: PipelineFinding = {
        step,
        severity: SEVERITIES[mark!]!,
        text: plainText(text!),
        ...(path !== undefined && at >= 1 ? { path: plainText(path), line: at } : {}),
      };
      const repeated = `${finding.severity}\u0000${finding.path ?? ''}\u0000${finding.line ?? ''}\u0000${finding.text}`;
      if (seen.has(repeated)) continue;
      seen.add(repeated);
      findings.push(finding);
    }
  }
  return findings;
}

/**
 * Reads the pipeline report in a description: the last attestation it
 * carries, checked against the pull request's head commit, and the
 * findings the step reports after it leave open.
 */
export function readPipelineReport(description: string, headSha: string): PipelineReport {
  const markers = [...description.matchAll(ATTESTATION)];
  const marker = markers[markers.length - 1];
  if (marker === undefined) {
    return { attestation: 'missing', detail: 'the description carries no no-mistakes attestation', steps: [], findings: [] };
  }
  const findings = readFindings(description.slice(marker.index + marker[0].length));
  let json: unknown;
  try {
    json = JSON.parse(marker[1]!);
  } catch {
    return { attestation: 'malformed', detail: 'the attestation cannot be read: its JSON does not parse', steps: [], findings };
  }
  const steps = readSteps(json);
  if (typeof steps === 'string') return { attestation: 'malformed', detail: `the attestation cannot be read: ${steps}`, steps: [], findings };
  const attested = ((json as { head_sha: string }).head_sha).toLowerCase();
  if (attested !== headSha.toLowerCase()) {
    const detail = `the report was made at ${short(attested)}, but the pull request's head is now ${short(headSha)}: it is shown, not trusted`;
    return { attestation: 'stale', detail, headSha: attested, steps, findings };
  }
  const detail = `the report was made at the pull request's head ${short(headSha)}, so its open findings are listed first among the claims`;
  return { attestation: 'fresh', detail, headSha: attested, steps, findings };
}

/**
 * The part a finding is about: the part holding the line it names, else
 * the first part holding its file, else the first part in reading order.
 */
function partOf(parts: readonly Part[], finding: PipelineFinding): number {
  const holds = (part: Part): boolean => filesOfPart(part).some((file) => file.path === finding.path);
  const atLine = finding.line === undefined ? -1 : parts.findIndex((part) => lineInChange([part], finding.path!, finding.line!));
  if (atLine >= 0) return atLine;
  return Math.max(parts.findIndex(holds), 0);
}

/**
 * A fresh report's open findings as claims, first in priority, each
 * attached to the part it is about and not checked yet; a report that is
 * not fresh, or a change with no parts, gives none.
 */
export function pipelineClaims(report: PipelineReport, parts: readonly Part[]): Claim[] {
  if (report.attestation !== 'fresh' || parts.length === 0) return [];
  return report.findings.map((finding, index) => ({
    quote: finding.text.length > MAX_FINDING_TEXT ? `${finding.text.slice(0, MAX_FINDING_TEXT - 1)}…` : finding.text,
    source: 'pipeline',
    location: {
      kind: 'pipeline',
      finding: index,
      step: finding.step,
      ...(finding.path !== undefined ? { path: finding.path } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
    },
    part: partOf(parts, finding),
    verdict: { kind: 'not checked' },
  }));
}
