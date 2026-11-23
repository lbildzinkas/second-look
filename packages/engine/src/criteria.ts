import type { IssueTrackerSource, LinkedIssuesRead, LinkedIssuesRequest } from './issue-sources.js';
import type { AcceptanceCriterion, Criteria } from './protocol.js';

/**
 * The criteria pass: reads the issues the pull request links, from each
 * issue tracker source, and lists each condition from the checklist
 * under the configured heading, quoted and not checked. Model-free, like
 * every plain pass. Issue text is untrusted: it is parsed and never
 * followed, and the hidden content the tracker does not show stays in
 * the quotes for the panel to flag.
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

/** One source's read, kept whatever happens: a source that throws reads as unreadable, saying why. */
async function readSource(source: IssueTrackerSource, pr: LinkedIssuesRequest): Promise<LinkedIssuesRead> {
  try {
    return await source.readLinkedIssues(pr);
  } catch (error) {
    return { issues: [], outcome: 'unreadable', detail: `the linked issues could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Reads the acceptance criteria of one pull request: the issues each
 * issue tracker source finds it links, source by source in the order
 * given, and each checklist under the heading. A source that cannot read
 * never fails the review: its read says why, and the criteria are
 * unreadable only when no source could read. Each criterion starts as
 * not checked; judging them is a later pass.
 */
export async function readCriteria(
  sources: readonly IssueTrackerSource[],
  pr: LinkedIssuesRequest,
  heading: string,
): Promise<Criteria> {
  const reads = await Promise.all(sources.map((source) => readSource(source, pr)));
  const issues = reads.flatMap((read) => read.issues);
  return {
    outcome: reads.some((read) => read.outcome === 'read') ? 'read' : 'unreadable',
    detail: reads.map((read) => read.detail).join('; '),
    sources: reads.map((read, index) => ({ source: sources[index]!.source, outcome: read.outcome, detail: read.detail })),
    heading,
    issues,
    criteria: issues.flatMap((issue, index) => criteriaOf(index, issue.body, heading)),
  };
}
