import type { GitHubClient, PullRequestRef } from './github.js';
import type { AcceptanceCriterion, Criteria, LinkedIssue } from './protocol.js';

/**
 * The criteria pass: reads the issues the pull request links and lists
 * each condition from the checklist under the configured heading, quoted
 * and not checked. Model-free, like every plain pass. Issue text is
 * untrusted: it is parsed and never followed, and the hidden content
 * GitHub does not show stays in the quotes for the panel to flag.
 */

/** The heading the criteria checklist is read from under, unless configured otherwise. */
export const DEFAULT_CRITERIA_HEADING = 'Acceptance criteria';

/** The longest criterion quote kept, so an issue cannot flood the result. */
const MAX_QUOTE = 2000;

/** An ATX heading line, its text captured, closing hashes dropped. */
const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** One task-list item, its checkbox mark and its text captured. */
const TASK_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]*(.*)$/;

/** A heading's text, as the heading is matched against the configured one. */
function headingText(line: string): string | undefined {
  return HEADING.exec(line)?.[1]?.trim();
}

/**
 * Reads the checklist under one heading in an issue's body: every task
 * item under the first matching heading that lists any, in the body's
 * order — nested items and loose lists included — with room for plain
 * words before the list starts. The section ends at another heading, or
 * at the first line that is neither a task item nor blank once the list
 * has started. A matching heading that lists nothing is passed over, so
 * an issue that repeats the heading keeps the checklist that follows its
 * later occurrence. Nothing in the body is followed; only its task items
 * are quoted.
 */
export function checklistUnder(body: string, heading: string): { text: string; line: number }[] {
  const lines = body.split(/\r?\n/);
  const wanted = heading.trim().toLowerCase();
  for (let at = 0; at < lines.length; at++) {
    if (headingText(lines[at]!)?.toLowerCase() !== wanted) continue;
    const items: { text: string; line: number }[] = [];
    for (let scan = at + 1; scan < lines.length; scan++) {
      const line = lines[scan]!;
      // Blank lines run between the heading and its list, and between
      // the items of a loose list.
      if (line.trim() === '') continue;
      // Another heading ends the section, before the list as after it.
      if (headingText(line) !== undefined) break;
      const match = TASK_ITEM.exec(line);
      // Plain words before the first item introduce the list; after it,
      // the section ends. A checkbox with no words lists nothing.
      if (match === null) {
        if (items.length > 0) break;
        continue;
      }
      const text = match[2]?.replace(/\s+/g, ' ').trim();
      if (text !== undefined && text !== '') items.push({ text, line: scan + 1 });
    }
    if (items.length > 0) return items;
  }
  return [];
}

/** One issue's checklist as criteria, each quoted and not checked. */
function criteriaOf(issue: number, body: string, heading: string): AcceptanceCriterion[] {
  return checklistUnder(body, heading).map(({ text, line }) => ({
    quote: text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE - 1)}…` : text,
    issue,
    line,
    verdict: { kind: 'not checked' },
  }));
}

/** Plain words for why something could not be read, the token never among them. */
function reason(error: unknown): string {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof status === 'number') return `GitHub answered ${status}`;
  return error instanceof Error ? error.message : String(error);
}

/** How many of the linked issues the pull request closes. */
function closingCount(issues: readonly LinkedIssue[]): number {
  return issues.filter((issue) => issue.link === 'closes').length;
}

/** One plain line saying what was read of the pull request's linked issues. */
function detailOf(issues: readonly LinkedIssue[], base: string, defaultBranch: string): string {
  const closing = closingCount(issues);
  const referencing = issues.length - closing;
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  if (closing === 0 && base !== defaultBranch) {
    const beside =
      referencing === 0
        ? ', and no issue references it'
        : `, while ${plural(referencing, 'issue', 'issues')} still reference${referencing === 1 ? 's' : ''} it`;
    return `GitHub returns no closing references for a pull request into ${base}, not the repository's default branch ${defaultBranch}${beside}`;
  }
  if (closing === 0) {
    return referencing === 0
      ? 'this pull request links no issue'
      : `${plural(referencing, 'issue references', 'issues reference')} this pull request and none will be closed by it`;
  }
  const beside = referencing === 0 ? '' : ` and ${plural(referencing, 'issue', 'issues')} that reference${referencing === 1 ? 's' : ''} it`;
  return `${plural(closing, 'issue', 'issues')} this pull request closes${beside}`;
}

/**
 * Reads the acceptance criteria of one pull request: the issues it links
 * — closing references, sidebar links and issues in other repositories —
 * and each checklist under the heading. Issues that cannot be read never
 * fail the review: the result says why. Each criterion starts as not
 * checked; judging them is a later pass.
 */
export async function readCriteria(
  client: GitHubClient,
  ref: PullRequestRef,
  base: string,
  heading: string,
): Promise<Criteria> {
  let linked: { defaultBranch: string; issues: LinkedIssue[] };
  try {
    linked = await client.getLinkedIssues(ref);
  } catch (error) {
    return {
      outcome: 'unreadable',
      detail: `the linked issues could not be read: ${reason(error)}`,
      heading,
      issues: [],
      criteria: [],
    };
  }
  const issues = linked.issues;
  return {
    outcome: 'read',
    detail: detailOf(issues, base, linked.defaultBranch),
    heading,
    issues,
    criteria: issues.flatMap((issue, index) => criteriaOf(index, issue.body, heading)),
  };
}
