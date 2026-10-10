import {
  ASK_KINDS,
  CHECKED_VERDICT_KINDS,
  CLAIM_SOURCE_ORDER,
  CRITERION_VERDICT_KINDS,
  EVIDENCE_SOURCES,
  FINDING_REF_KINDS,
  IMPORTANCE_ORDER,
  LIBRARY_ARCHIVES,
  REVIEW_RESULT_VERSION,
  type AskAnswer,
  type ChangeKind,
  type DiffLineKind,
  type DraftComment,
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
  type ReviewedMarks,
  type ReviewResult,
  type SentReview,
  type SyntaxCheck,
  type ViewedFiles,
} from '@second-look/engine';

/** How the pull request links an issue, as the result names it. */
const ISSUE_LINKS = ['closes', 'references'] as const;

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
  const blobs = value['blobs'];
  if (blobs !== undefined && !(isRecord(blobs) && isString(blobs['old']) && isString(blobs['new']))) return false;
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
    isString(value['runAt']) &&
    // The reviewer's own account label, when the settings gave one.
    (value['account'] === undefined || isString(value['account']))
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

/** Whether a number is a 1-based line. */
function isLine(value: unknown): value is number {
  return isNumber(value) && value >= 1;
}

/** Where a claim's quote sits: a description line, added file lines, a story sentence the result has, or a pipeline finding. */
function isClaimLocation(value: unknown, sentenceCount: number): boolean {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'description':
      return isLine(value['line']);
    case 'file':
      return isNonEmptyString(value['path']) && isLine(value['line']) && isLine(value['endLine']) && value['endLine'] >= value['line'];
    case 'story':
      return isNumber(value['sentence']) && value['sentence'] < sentenceCount;
    case 'pipeline':
      return isNumber(value['finding']) && isNonEmptyString(value['step']) && isOptionalString(value['path']) && (value['line'] === undefined || isLine(value['line']));
    default:
      return false;
  }
}

/** One line a verdict cites: its file, or the check run whose CI log holds it, its line and quote. */
function isCitation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value['path']) &&
    isLine(value['line']) &&
    isNonEmptyString(value['quote']) &&
    (value['ciLog'] === undefined || value['ciLog'] === true)
  );
}

/** A repository and tag the agent named for a library. */
function isNamedRepository(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value['url']) && isNonEmptyString(value['tag']);
}

/** A library fetch a verdict offers: the library, its pinned version, the lock file and why, or the repository and tag the agent named, and the decompile it turned into when it found no exact source. */
function isLibraryFetchOffer(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value['library']) &&
    isNonEmptyString(value['pinnedVersion']) &&
    isNonEmptyString(value['pinnedBy']) &&
    isString(value['reason']) &&
    (value['namedRepository'] === undefined || isNamedRepository(value['namedRepository'])) &&
    (value['decompile'] === undefined || (isRecord(value['decompile']) && isNonEmptyString(value['decompile']['licence'])))
  );
}

/** The library source a verdict was judged against: the file fetched, where it landed, its unproven files, and who judged. */
function isFetchedLibrary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value['library']) &&
    isNonEmptyString(value['pinnedVersion']) &&
    isNonEmptyString(value['pinnedBy']) &&
    isNonEmptyString(value['file']) &&
    isNonEmptyString(value['sha256']) &&
    isOneOf(value['archive'], LIBRARY_ARCHIVES) &&
    isNonEmptyString(value['path']) &&
    isOptionalString(value['note']) &&
    (value['unproven'] === undefined || isStringList(value['unproven'])) &&
    isString(value['promptVersion']) &&
    isAgentStamp(value['stamp'])
  );
}

/**
 * A claim's verdict: not checked, or checked with its evidence source,
 * reason and citations, the library fetch it offers and the library
 * source it was judged against. The model's memory never yields
 * verified, and cites no line.
 */
function isClaimVerdict(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'not checked') return true;
  const evidence = value['evidence'];
  if (
    !isOneOf(value['kind'], CHECKED_VERDICT_KINDS) ||
    !isOneOf(value['source'], EVIDENCE_SOURCES) ||
    !isString(value['reason']) ||
    !Array.isArray(evidence) ||
    !evidence.every(isCitation) ||
    !isOptionalString(value['needsLibrary']) ||
    (value['namedRepository'] !== undefined && !isNamedRepository(value['namedRepository'])) ||
    (value['libraryFetch'] !== undefined && !isLibraryFetchOffer(value['libraryFetch'])) ||
    !isOptionalString(value['noLibraryFetch']) ||
    (value['library'] !== undefined && !isFetchedLibrary(value['library'])) ||
    !isOptionalString(value['recheck'])
  ) {
    return false;
  }
  // A verdict from a CI log cites only its lines, and every other cites none.
  const fromLog = value['source'] === 'a CI log';
  if (!evidence.every((cited) => ((cited as { ciLog?: true }).ciLog === true) === fromLog)) return false;
  return value['source'] !== "the model's memory" || (value['kind'] !== 'verified' && evidence.length === 0);
}

/** The judging of the claims: judged or fallen back, always stamped. */
function isClaimJudging(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value['promptVersion']) &&
    isOneOf(value['outcome'], ['judged', 'fell back'] as const) &&
    isString(value['detail']) &&
    isAgentStamp(value['stamp'])
  );
}

/** One claim: its quote, source and location, the part it is attached to, its verdict, and its mark when the verify ask judged it alone. */
function isClaim(value: unknown, partCount: number, sentenceCount: number): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value['quote']) &&
    isOneOf(value['source'], CLAIM_SOURCE_ORDER) &&
    // A claim from the story sits in a story sentence, and every other claim outside it; so with the pipeline's findings.
    (value['source'] === 'agent') === (isRecord(value['location']) && value['location']['kind'] === 'story') &&
    (value['source'] === 'pipeline') === (isRecord(value['location']) && value['location']['kind'] === 'pipeline') &&
    isClaimLocation(value['location'], sentenceCount) &&
    isNumber(value['part']) &&
    value['part'] < partCount &&
    isClaimVerdict(value['verdict']) &&
    (value['asked'] === undefined || value['asked'] === true)
  );
}

/**
 * The claims of the result's parts: listed, or fallen back with only the
 * pipeline's and any the verify ask judged, always stamped; a claim
 * carries a checked verdict only once the claims were judged, or once
 * the Verify this claim ask judged it alone, which marks the claim.
 */
function isClaims(value: unknown, partCount: number, sentenceCount: number): boolean {
  if (!isRecord(value)) return false;
  const claims = value['claims'];
  const judging = value['judging'];
  if (judging !== undefined && !isClaimJudging(judging)) return false;
  const judged = isRecord(judging) && judging['outcome'] === 'judged';
  if (
    !isString(value['promptVersion']) ||
    !isOneOf(value['outcome'], ['listed', 'fell back'] as const) ||
    !isString(value['detail']) ||
    !isAgentStamp(value['stamp']) ||
    !Array.isArray(claims)
  ) {
    return false;
  }
  if (value['outcome'] === 'fell back' && !claims.every((claim) => isRecord(claim) && (claim['source'] === 'pipeline' || claim['asked'] === true))) return false;
  return claims.every(
    (claim) =>
      isClaim(claim, partCount, sentenceCount) &&
      (judged || (claim as { verdict: { kind: unknown }; asked?: unknown }).verdict.kind === 'not checked' || (claim as { asked?: unknown }).asked === true),
  );
}

/** The pipeline report the description carries: its attestation's state, its steps and its open findings. */
function isPipelineReport(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { steps, findings } = value;
  return (
    isOneOf(value['attestation'], ['fresh', 'stale', 'missing', 'malformed'] as const) &&
    isString(value['detail']) &&
    isOptionalString(value['headSha']) &&
    Array.isArray(steps) &&
    steps.every((step) => isRecord(step) && isString(step['step']) && isString(step['status'])) &&
    Array.isArray(findings) &&
    findings.every(
      (finding) =>
        isRecord(finding) &&
        isString(finding['step']) &&
        isOneOf(finding['severity'], ['error', 'warning', 'info'] as const) &&
        isString(finding['text']) &&
        isOptionalString(finding['path']) &&
        (finding['line'] === undefined || isLine(finding['line'])),
    )
  );
}

/** One check run: its name, status and conclusion, its annotations, and a failed job's trimmed log. */
function isCheckRun(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { annotations, log } = value;
  return (
    isString(value['name']) &&
    isString(value['status']) &&
    (value['conclusion'] === null || isString(value['conclusion'])) &&
    isString(value['url']) &&
    Array.isArray(annotations) &&
    annotations.every(
      (annotation) =>
        isRecord(annotation) &&
        isString(annotation['path']) &&
        (annotation['startLine'] === undefined || isNumber(annotation['startLine'])) &&
        (annotation['endLine'] === undefined || isNumber(annotation['endLine'])) &&
        isOneOf(annotation['level'], ['notice', 'warning', 'failure'] as const) &&
        isString(annotation['message']) &&
        isOptionalString(annotation['title']),
    ) &&
    (log === undefined || (isRecord(log) && isOptionalString(log['step']) && isStringList(log['lines']) && isString(log['detail'])))
  );
}

/** The CI read at the head commit: read or unreadable, with the check runs. */
function isCiResults(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value['outcome'], ['read', 'unreadable'] as const) &&
    isString(value['detail']) &&
    isString(value['headSha']) &&
    isOptionalString(value['mergeCommit']) &&
    Array.isArray(value['checks']) &&
    value['checks'].every(isCheckRun)
  );
}

/** One issue the pull request links: its number, title, page, repository and full body, and how it is linked. */
function isLinkedIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value['number']) &&
    isString(value['title']) &&
    isString(value['url']) &&
    isString(value['repository']) &&
    isString(value['body']) &&
    isOneOf(value['link'], ISSUE_LINKS)
  );
}

/** A manual check the description reports: its quote and the description line it starts on. */
function isManualCheck(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value['quote']) && isLine(value['line']);
}

/**
 * A criterion's verdict: not checked, or mapped with its reason, the code
 * and tests it cites in the head copy — never a CI log's lines — and the
 * manual checks the description reports.
 */
function isCriterionVerdict(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'not checked') return true;
  const inHeadCopy = (cited: unknown): boolean => isCitation(cited) && (cited as { ciLog?: true }).ciLog === undefined;
  return (
    isOneOf(value['kind'], CRITERION_VERDICT_KINDS) &&
    isString(value['reason']) &&
    !/[\r\n]/.test(value['reason']) &&
    Array.isArray(value['code']) &&
    value['code'].every(inHeadCopy) &&
    Array.isArray(value['tests']) &&
    value['tests'].every(inHeadCopy) &&
    Array.isArray(value['manualChecks']) &&
    value['manualChecks'].every(isManualCheck) &&
    isOptionalString(value['recheck'])
  );
}

/** One acceptance criterion: quoted from a linked issue's checklist, with its verdict. */
function isCriterion(value: unknown, issueCount: number): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value['quote']) &&
    isNumber(value['issue']) &&
    value['issue'] < issueCount &&
    isLine(value['line']) &&
    isCriterionVerdict(value['verdict'])
  );
}

/** The mapping of the criteria to the change: mapped or fallen back, always stamped. */
function isCriteriaMapping(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value['promptVersion']) &&
    isOneOf(value['outcome'], ['mapped', 'fell back'] as const) &&
    isString(value['detail']) &&
    isAgentStamp(value['stamp'])
  );
}

/**
 * The acceptance criteria read from the issues the pull request links:
 * read or unreadable, the issues with the heading their checklists were
 * read from under, and the criteria quoted — every one mapped when the
 * agent mapped them, and every one not checked otherwise.
 */
function isCriteria(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isOneOf(value['outcome'], ['read', 'unreadable'] as const) || !isString(value['detail']) || !isNonEmptyString(value['heading'])) {
    return false;
  }
  if (!Array.isArray(value['issues']) || !value['issues'].every(isLinkedIssue)) return false;
  const issues = value['issues'];
  const criteria = value['criteria'];
  if (!Array.isArray(criteria) || !criteria.every((criterion) => isCriterion(criterion, issues.length))) return false;
  const mapping = value['mapping'];
  if (mapping !== undefined && !isCriteriaMapping(mapping)) return false;
  const mapped = isRecord(mapping) && mapping['outcome'] === 'mapped';
  return criteria.every((criterion) => ((criterion as { verdict: { kind: string } }).verdict.kind !== 'not checked') === mapped);
}

/** A one-line reason the companion shows. */
function isReason(value: unknown): boolean {
  return isNonEmptyString(value) && !/[\r\n]/.test(value);
}

/** Where a described change is quoted from: a description line, or a line of a linked issue the result has. */
function isDescribedLocation(value: unknown, issueCount: number): boolean {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'description') return isLine(value['line']);
  return value['kind'] === 'issue' && isNumber(value['issue']) && value['issue'] < issueCount && isLine(value['line']);
}

/**
 * The unexplained changes: compared, fallen back or not compared, stamped
 * whenever an agent was asked; only a comparison flags parts — each a
 * part the result has, once, with a one-line reason — or lists described
 * changes, each quoted from the description or a linked issue.
 */
function isUnexplained(value: unknown, partCount: number, issueCount: number): boolean {
  if (!isRecord(value)) return false;
  const { parts, described } = value;
  if (
    !isString(value['promptVersion']) ||
    !isOneOf(value['outcome'], ['compared', 'fell back', 'not compared'] as const) ||
    !isString(value['detail']) ||
    !Array.isArray(parts) ||
    !Array.isArray(described)
  ) {
    return false;
  }
  if (value['outcome'] === 'not compared' ? value['stamp'] !== undefined : !isAgentStamp(value['stamp'])) return false;
  if (value['outcome'] !== 'compared' && (parts.length > 0 || described.length > 0)) return false;
  const flagged = parts.map((part) => (isRecord(part) ? part['part'] : undefined));
  return (
    parts.every((part) => isRecord(part) && isNumber(part['part']) && part['part'] < partCount && isReason(part['reason'])) &&
    new Set(flagged).size === flagged.length &&
    described.every(
      (change) => isRecord(change) && isNonEmptyString(change['quote']) && isDescribedLocation(change['location'], issueCount) && isReason(change['reason']),
    )
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
 * Checks what changed since the reviewer's last look: the commit it was
 * at, where the look comes from, when it was, whether the changes were
 * compared, and the hashes of the pieces that changed.
 */
function isSinceLastLook(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value['commit']) &&
    isOneOf(value['from'], ['local record', 'github review'] as const) &&
    isString(value['at']) &&
    isOneOf(value['outcome'], ['compared', 'not compared'] as const) &&
    Array.isArray(value['changed']) &&
    value['changed'].every((piece) => isString(piece) && SHA256.test(piece))
  );
}

/** A library API the change uses: its name, its library as pinned, and the head-side lines that use it. */
function isLibraryApi(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value['api']) &&
    isNonEmptyString(value['library']) &&
    isNonEmptyString(value['version']) &&
    isNonEmptyString(value['pinnedBy']) &&
    isOneOf(value['ecosystem'], ['PyPI', 'NuGet', '.NET'] as const) &&
    Array.isArray(value['uses']) &&
    value['uses'].every((use) => isRecord(use) && isNonEmptyString(use['path']) && isLine(use['line']) && isNonEmptyString(use['name']))
  );
}

/** An https address, the only kind a documentation link may open. */
function isHttpsUrl(value: unknown): boolean {
  if (!isString(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The documentation links: each an API with an https page, an inventory's
 * naming the inventory it came from, every inventory link before any the
 * agent suggested, and a suggestion only when the agent's suggestions are
 * there to stamp it.
 */
function isDocLinks(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { links, unlinked, notes, suggestions } = value;
  if (!Array.isArray(links) || !Array.isArray(unlinked) || !unlinked.every(isLibraryApi) || !Array.isArray(notes) || !notes.every(isString)) return false;
  if (
    suggestions !== undefined &&
    !(
      isRecord(suggestions) &&
      isString(suggestions['promptVersion']) &&
      isOneOf(suggestions['outcome'], ['suggested', 'fell back'] as const) &&
      isString(suggestions['detail']) &&
      isAgentStamp(suggestions['stamp'])
    )
  ) {
    return false;
  }
  const valid = links.every((link) => {
    if (!isLibraryApi(link)) return false;
    const { url, from, inventory } = link as Record<string, unknown>;
    return isHttpsUrl(url) && (from === 'inventory' ? isHttpsUrl(inventory) : from === 'agent' && inventory === undefined);
  });
  if (!valid) return false;
  const kinds = links.map((link) => (link as { from: string }).from);
  const firstSuggested = kinds.indexOf('agent');
  if (firstSuggested >= 0 && (kinds.slice(firstSuggested).includes('inventory') || !isRecord(suggestions) || suggestions['outcome'] !== 'suggested')) return false;
  return true;
}

/** A review's budget: its limits, each 0 for none, and its use so far, as counts and sizes of 0 or more. */
function isBudget(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value['limits']) || !isRecord(value['used'])) return false;
  const { limits, used } = value;
  const mib = limits['downloadMiB'];
  return (
    isNumber(limits['agentRuns']) &&
    isNumber(limits['filesFetched']) &&
    typeof mib === 'number' &&
    Number.isFinite(mib) &&
    mib >= 0 &&
    isNumber(used['agentRuns']) &&
    isNumber(used['filesFetched']) &&
    isNumber(used['downloadBytes'])
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
  if (!isPipelineReport(value['pipeline'])) return false;
  if (value['ci'] !== undefined && !isCiResults(value['ci'])) return false;
  if (value['criteria'] !== undefined && !isCriteria(value['criteria'])) return false;
  if (value['sinceLastLook'] !== undefined && !isSinceLastLook(value['sinceLastLook'])) return false;
  if (value['docLinks'] !== undefined && !isDocLinks(value['docLinks'])) return false;
  if (value['budget'] !== undefined && !isBudget(value['budget'])) return false;
  const parts = value['parts'];
  if (!Array.isArray(parts) || !parts.every(isPart)) return false;
  const story = value['story'];
  if (story !== undefined && !isStory(story, parts.length)) return false;
  const issues = isRecord(value['criteria']) && Array.isArray(value['criteria']['issues']) ? value['criteria']['issues'].length : 0;
  if (value['unexplained'] !== undefined && !isUnexplained(value['unexplained'], parts.length, issues)) return false;
  const sentences = isRecord(story) && Array.isArray(story['sentences']) ? story['sentences'].length : 0;
  return value['claims'] === undefined || isClaims(value['claims'], parts.length, sentences);
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

/**
 * Checks that a value read over the protocol is a draft comment: the
 * finding it was drafted from, that finding's statement, the draft's
 * text and who drafted it.
 */
export function isDraftComment(value: unknown): value is DraftComment {
  if (!isRecord(value) || !isRecord(value['finding'])) return false;
  const { kind, index } = value['finding'];
  return (
    isOneOf(kind, FINDING_REF_KINDS) &&
    isNumber(index) &&
    Number.isInteger(index) &&
    index >= 0 &&
    isString(value['statement']) &&
    isNonEmptyString(value['body']) &&
    isString(value['promptVersion']) &&
    isAgentStamp(value['stamp'])
  );
}

/** Error thrown when a draft's answer is not a draft comment. */
export class DraftProtocolError extends Error {
  constructor() {
    super(`the engine's answer is not a draft comment`);
    this.name = 'DraftProtocolError';
  }
}

/** A verify ask's judged claim: its index in the review's claims, and the claim, about the part asked about. */
function isVerifiedClaim(value: unknown, part: number): boolean {
  if (!isRecord(value)) return false;
  const { index, claim } = value;
  return isNumber(index) && Number.isInteger(index) && index >= 0 && isClaim(claim, part + 1, Number.MAX_SAFE_INTEGER) && isRecord(claim) && claim['part'] === part;
}

/**
 * Checks that a value read over the protocol is the answer to an ask:
 * the ask and the part it is about, its sections, the lines it cites,
 * who answered, and any claim a verify ask judged.
 */
export function isAskAnswer(value: unknown): value is AskAnswer {
  if (!isRecord(value)) return false;
  const { part, sections, cited } = value;
  return (
    isOneOf(value['ask'], ASK_KINDS) &&
    isNumber(part) &&
    Number.isInteger(part) &&
    part >= 0 &&
    isString(value['partName']) &&
    Array.isArray(sections) &&
    sections.length > 0 &&
    sections.every((section) => isRecord(section) && isString(section['heading']) && isNonEmptyString(section['text'])) &&
    Array.isArray(cited) &&
    cited.every(
      (each) =>
        isRecord(each) &&
        isString(each['path']) &&
        (each['side'] === 'head' || each['side'] === 'base') &&
        isNumber(each['line']) &&
        Number.isInteger(each['line']) &&
        each['line'] >= 1 &&
        isString(each['quote']),
    ) &&
    isString(value['promptVersion']) &&
    isAgentStamp(value['stamp']) &&
    (value['claim'] === undefined || isVerifiedClaim(value['claim'], part))
  );
}

/** Error thrown when an ask's answer is not the answer to an ask. */
export class AskProtocolError extends Error {
  constructor() {
    super(`the engine's answer is not the answer to an ask`);
    this.name = 'AskProtocolError';
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

/** Error thrown when a marks answer is not the reviewed marks. */
export class MarksProtocolError extends Error {
  constructor() {
    super(`the engine's answer is not the pull request's reviewed marks`);
    this.name = 'MarksProtocolError';
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Checks that a value read over the protocol is the reviewed marks: each
 * mark keyed by a content hash, with the part's name, its pieces' hashes
 * and when it was marked.
 */
export function isReviewedMarks(value: unknown): value is ReviewedMarks {
  if (!isRecord(value) || !Array.isArray(value['marks'])) return false;
  return value['marks'].every(
    (mark) =>
      isRecord(mark) &&
      isString(mark['hash']) &&
      SHA256.test(mark['hash']) &&
      isString(mark['name']) &&
      isString(mark['markedAt']) &&
      Array.isArray(mark['pieces']) &&
      mark['pieces'].every((piece) => isString(piece) && SHA256.test(piece)),
  );
}

/** Checks that a value read over the protocol lists the files marked "Viewed" on GitHub. */
export function isViewedFiles(value: unknown): value is ViewedFiles {
  return isRecord(value) && Array.isArray(value['paths']) && value['paths'].every(isString);
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
