import {
  IMPORTANCE_ORDER,
  REVIEW_RESULT_VERSION,
  type ChangeKind,
  type DiffLineKind,
  type EntityChange,
  type EntityKind,
  type FormattingOnlyStatus,
  type Importance,
  type NoiseLabel,
  type NoiseRule,
  type NoiseState,
  type Novelty,
  type PartOrigin,
  type PartRank,
  type PartRole,
  type ReviewResult,
  type SentReview,
  type SyntaxCheck,
} from '@second-look/engine';

const CHANGE_KINDS: readonly ChangeKind[] = [
  'addition',
  'deletion',
  'modification',
  'rename',
  'copy',
];

const LINE_KINDS: readonly DiffLineKind[] = ['context', 'addition', 'deletion'];

const NOISE_LABELS: readonly NoiseLabel[] = [
  'lockfile',
  'generated',
  'vendored',
  'moved or renamed',
  'snapshot',
  'fixture',
];

const NOISE_RULES: readonly NoiseRule[] = [
  'rename-identical',
  'snapshot-name',
  'fixture-path',
  'linguist-generated',
  'linguist-vendored',
  'lockfile-name',
  'lockfile-follows-manifest',
  'lockfile-unexplained',
  'generated-name',
  'generated-header',
];

const NOISE_STATES: readonly NoiseState[] = ['confirmed', 'claimed'];

const ENTITY_KINDS: readonly EntityKind[] = [
  'class',
  'struct',
  'interface',
  'enum',
  'trait',
  'impl',
  'type',
  'function',
  'method',
  'property',
];

const ENTITY_CHANGES: readonly EntityChange[] = ['added', 'removed', 'declaration', 'body'];

const NOVELTIES: readonly Novelty[] = ['new', 'changed', 'removed'];

const ROLES: readonly PartRole[] = ['test', 'code'];

const FORMATTING_STATUSES: readonly FormattingOnlyStatus[] = [
  'confirmed',
  'structure-changed',
  'not-checked',
];

const SYNTAX_CHECKS: readonly SyntaxCheck[] = ['entities', 'formatting-only'];

const ORIGINS: readonly PartOrigin[] = ['plain', 'agent', 'not grouped by the agent'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return isString(value) && allowed.includes(value as T);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isNumber(value);
}

function isDiffLine(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isString(value['text'])) return false;
  const kind = value['kind'];
  if (!isString(kind) || !LINE_KINDS.includes(kind as DiffLineKind)) return false;
  return (
    isOptionalNumber(value['oldLineNumber']) &&
    isOptionalNumber(value['newLineNumber']) &&
    (value['endsWithoutNewline'] === undefined ||
      typeof value['endsWithoutNewline'] === 'boolean')
  );
}

function isHunk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isNumber(value['oldStart']) ||
    !isNumber(value['oldLines']) ||
    !isNumber(value['newStart']) ||
    !isNumber(value['newLines'])
  ) {
    return false;
  }
  if (!isOptionalString(value['heading'])) return false;
  return (
    Array.isArray(value['lines']) &&
    value['lines'].every(isDiffLine) &&
    Array.isArray(value['entities']) &&
    value['entities'].every(isEntity)
  );
}

function isEntity(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value['kind'], ENTITY_KINDS) &&
    isString(value['name']) &&
    typeof value['public'] === 'boolean' &&
    isOneOf(value['change'], ENTITY_CHANGES)
  );
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

function isPartSignals(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const references = value['references'];
  return (
    isOneOf(value['novelty'], NOVELTIES) &&
    isOneOf(value['role'], ROLES) &&
    isNumber(value['changedLines']) &&
    isStringList(value['publicSurface']) &&
    isRecord(references) &&
    // The reference count matches names only, and must say so.
    references['basis'] === 'name-based' &&
    isStringList(references['names']) &&
    isNumber(references['files'])
  );
}

function isPartSyntax(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isOptionalString(value['language'])) return false;
  const formattingOnly = value['formattingOnly'];
  if (
    !isRecord(formattingOnly) ||
    !isOneOf(formattingOnly['status'], FORMATTING_STATUSES) ||
    !isString(formattingOnly['reason'])
  ) {
    return false;
  }
  const checksNotRun = value['checksNotRun'];
  return (
    Array.isArray(checksNotRun) &&
    checksNotRun.every(
      (check) =>
        isRecord(check) && isOneOf(check['check'], SYNTAX_CHECKS) && isString(check['reason']),
    )
  );
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isNoiseAssessment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const label = value['label'];
  if (!isString(label)) return false;
  if (label === 'none') {
    // The plain statement that no rule applied, per ADR 0001.
    return value['note'] === 'no rule applied';
  }
  if (!NOISE_LABELS.includes(label as NoiseLabel)) return false;
  const rule = value['rule'];
  if (!isString(rule) || !NOISE_RULES.includes(rule as NoiseRule)) return false;
  const state = value['state'];
  if (!isString(state) || !NOISE_STATES.includes(state as NoiseState)) return false;
  // Every label carries a one-line blind spot, so it cannot be empty.
  return isNonEmptyString(value['blindSpot']);
}

function isPartRank(value: unknown): value is PartRank {
  if (!isRecord(value)) return false;
  const importance = value['importance'];
  if (!isString(importance) || !IMPORTANCE_ORDER.includes(importance as Importance)) {
    return false;
  }
  // The importance is always shown with its one-line reason (the glossary).
  if (!isNonEmptyString(value['reason'])) return false;
  return Array.isArray(value['signals']) && value['signals'].every(isNonEmptyString);
}

/** One file's share of a part: the file's own fields and the hunks of it the part holds. */
function isFileSlice(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isString(value['path'])) return false;
  if (!isOptionalString(value['previousPath'])) return false;
  const changeKind = value['changeKind'];
  if (!isString(changeKind) || !CHANGE_KINDS.includes(changeKind as ChangeKind)) {
    return false;
  }
  if (typeof value['isBinary'] !== 'boolean') return false;
  if (
    typeof value['oldMissingFinalNewline'] !== 'boolean' ||
    typeof value['newMissingFinalNewline'] !== 'boolean'
  ) {
    return false;
  }
  if (!isOptionalString(value['oldMode']) || !isOptionalString(value['newMode'])) {
    return false;
  }
  if (!isNumber(value['additions']) || !isNumber(value['deletions'])) return false;
  if (!Array.isArray(value['hunks']) || !value['hunks'].every(isHunk)) return false;
  if (!isPartSyntax(value['syntax'])) return false;
  return isNoiseAssessment(value['noise']);
}

function isPart(value: unknown): boolean {
  if (!isRecord(value) || !isFileSlice(value)) return false;
  // The engine sets the name, noise, signals, origin and rank on every
  // part before printing; the rank stays optional for a reader that meets
  // a part without one, and when present it carries an importance, its
  // reason and the signals the reason cites. A part across files lists
  // its further files, each with its own noise.
  if (!isNonEmptyString(value['name'])) return false;
  if (!isPartSignals(value['signals'])) return false;
  if (value['origin'] !== undefined && !isOneOf(value['origin'], ORIGINS)) return false;
  const otherFiles = value['otherFiles'];
  if (otherFiles !== undefined && !(Array.isArray(otherFiles) && otherFiles.every(isFileSlice))) {
    return false;
  }
  return value['rank'] === undefined || isPartRank(value['rank']);
}

function isAgentStamp(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value['agent']) &&
    isString(value['agentVersion']) &&
    (value['model'] === null || isString(value['model'])) &&
    (value['effort'] === null || isString(value['effort'])) &&
    isString(value['runAt'])
  );
}

/** Who grouped the parts, and what came of asking the agent when it was asked. */
function isGrouping(value: unknown): boolean {
  if (!isRecord(value) || !isOneOf(value['by'], ['plain', 'agent'] as const)) return false;
  const agent = value['agent'];
  if (agent === undefined) return value['by'] === 'plain';
  return (
    isRecord(agent) &&
    isString(agent['promptVersion']) &&
    isOneOf(agent['outcome'], ['grouped', 'fell back'] as const) &&
    isString(agent['detail']) &&
    isNumber(agent['leftOut']) &&
    isAgentStamp(agent['stamp'])
  );
}

/** Who ranked the parts, and what came of the agent ranking stage when there was one. */
function isRanking(value: unknown): boolean {
  if (!isRecord(value) || !isOneOf(value['by'], ['plain', 'agent'] as const)) return false;
  const agent = value['agent'];
  if (agent === undefined) return value['by'] === 'plain';
  if (
    !isRecord(agent) ||
    !isString(agent['promptVersion']) ||
    !isOneOf(agent['outcome'], ['ranked', 'fell back', 'not tested'] as const) ||
    !isString(agent['detail'])
  ) {
    return false;
  }
  // The agent's ranking is shown only when it ranked, and then it says who answered.
  if (value['by'] === 'agent') return agent['outcome'] === 'ranked' && isAgentStamp(agent['stamp']);
  return agent['outcome'] !== 'ranked' && (agent['stamp'] === undefined || isAgentStamp(agent['stamp']));
}

/** One run of a story sentence: text, a code name, or the words linking a part the result has. */
function isStorySegment(value: unknown, partCount: number): boolean {
  if (!isRecord(value) || !isString(value['text'])) return false;
  const part = value['part'];
  if (part !== undefined && !(Number.isInteger(part) && (part as number) >= 0 && (part as number) < partCount)) return false;
  return value['code'] === undefined || typeof value['code'] === 'boolean';
}

/** The story of the result's parts: written with its sentences, or fallen back with none, always stamped. */
function isStory(value: unknown, partCount: number): boolean {
  if (!isRecord(value)) return false;
  const sentences = value['sentences'];
  if (
    !isString(value['promptVersion']) ||
    !isOneOf(value['outcome'], ['written', 'fell back'] as const) ||
    !isString(value['detail']) ||
    !isAgentStamp(value['stamp']) ||
    !Array.isArray(sentences)
  ) {
    return false;
  }
  if (value['outcome'] === 'fell back') return sentences.length === 0;
  return sentences.every(
    (sentence) =>
      isRecord(sentence) &&
      Array.isArray(sentence['segments']) &&
      sentence['segments'].every((segment) => isStorySegment(segment, partCount)),
  );
}

function isPullRequestSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isString(value['url']) &&
    isNumber(value['number']) &&
    isString(value['title']) &&
    isString(value['author']) &&
    isString(value['description']) &&
    isString(value['base']) &&
    isString(value['head']) &&
    isString(value['baseCommit']) &&
    isString(value['headSha'])
  );
}

function isChangeCopy(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value['commit']) &&
    isString(value['path']) &&
    typeof value['reused'] === 'boolean'
  );
}

/**
 * Checks that a value read over the protocol is a review result of the
 * version this extension understands. The engine and the extension share
 * the protocol types, so this guard only proves what JSON cannot: that the
 * bytes really carry that shape.
 */
export function isReviewResult(value: unknown): value is ReviewResult {
  if (!isRecord(value)) return false;
  if (value['version'] !== REVIEW_RESULT_VERSION) return false;
  if (!isPullRequestSummary(value['pullRequest'])) return false;
  const copies = value['copies'];
  if (!isRecord(copies) || !isChangeCopy(copies['base']) || !isChangeCopy(copies['head'])) {
    return false;
  }
  const parseTimeMs = value['parseTimeMs'];
  if (typeof parseTimeMs !== 'number' || !Number.isFinite(parseTimeMs) || parseTimeMs < 0) {
    return false;
  }
  if (!isGrouping(value['grouping']) || !isRanking(value['ranking'])) return false;
  const parts = value['parts'];
  if (!Array.isArray(parts) || !parts.every(isPart)) return false;
  return value['story'] === undefined || isStory(value['story'], parts.length);
}

/** Error thrown by {@link parseReviewResult} when the JSON is not a review result. */
export class ProtocolError extends Error {
  constructor() {
    super(
      `the engine's output is not a review result of version ${REVIEW_RESULT_VERSION}`,
    );
    this.name = 'ProtocolError';
  }
}

/** Error thrown when a send's answer is not a sent review. */
export class SendProtocolError extends Error {
  constructor() {
    super(`the engine's answer is not the link of a sent review`);
    this.name = 'SendProtocolError';
  }
}

/**
 * Checks that a value read over the protocol is a sent review: the one
 * field it carries, the review's link, as a string.
 */
export function isSentReview(value: unknown): value is SentReview {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { url?: unknown }).url === 'string' &&
    (value as { url: string }).url.length > 0
  );
}

/**
 * Reads the JSON the engine printed and returns it as a review result,
 * throwing {@link ProtocolError} when it does not match the shared,
 * versioned protocol.
 */
export function parseReviewResult(json: string): ReviewResult {
  const value: unknown = JSON.parse(json);
  if (!isReviewResult(value)) {
    throw new ProtocolError();
  }
  return value;
}
