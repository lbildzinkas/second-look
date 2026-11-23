import type { GitHubClient, GitHubIssue, PullRequestRef } from './github.js';
import type { UnkeyedCriteria } from './ticket-keys.js';
import type { Criteria, GitHubLinkedIssue, IssueSource, IssueSourceRead, KeyReference, LinkedIssue } from './protocol.js';

/**
 * Issue tracker sources (ADR 0010): where a pull request's linked issues
 * are read from, behind one small interface. Each source reads its own
 * issues and says what its read came to, so everything after the read is
 * the same whatever the source: criteria point at their issue by its
 * position in the list.
 */

/**
 * What a source is asked to read the linked issues of: the pull request,
 * the branch it goes into, and the key references it makes, none when
 * absent.
 */
export interface LinkedIssuesRequest {
  ref: PullRequestRef;
  base: string;
  keyReferences?: readonly KeyReference[];
}

/** What one source read: its issues, and its outcome with one plain line saying what was read or why nothing was. */
export interface LinkedIssuesRead {
  issues: LinkedIssue[];
  outcome: IssueSourceRead['outcome'];
  detail: string;
}

/**
 * One issue tracker the pull request's linked issues are read from. A
 * source never fails the review: one that cannot read says so in its
 * outcome.
 */
export interface IssueTrackerSource {
  readonly source: IssueSource;
  readLinkedIssues(pr: LinkedIssuesRequest): Promise<LinkedIssuesRead>;
}

/**
 * The key a GitHub issue is shown by: `#42` in the pull request's own
 * repository, `owner/name#42` in another. GitHub names repositories
 * without regard to letter case, so neither does the comparison.
 */
export function gitHubKey(ref: Pick<PullRequestRef, 'owner' | 'repo'>, issue: Pick<GitHubIssue, 'repository' | 'number'>): string {
  const own = issue.repository.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase();
  return own ? `#${issue.number}` : `${issue.repository}#${issue.number}`;
}

/** A GitHub issue as its source lists it: with its source and the key it is shown by. */
function sourced(ref: PullRequestRef, issue: GitHubIssue): GitHubLinkedIssue {
  return { source: 'github', key: gitHubKey(ref, issue), ...issue };
}

/** Plain words for why something could not be read, the token never among them. */
function reason(error: unknown): string {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof status === 'number') return `GitHub answered ${status}`;
  return error instanceof Error ? error.message : String(error);
}

/** How many of the linked issues the pull request closes. */
function closingCount(issues: readonly GitHubIssue[]): number {
  return issues.filter((issue) => issue.link === 'closes').length;
}

/** One plain line saying what was read of the pull request's linked issues. */
function detailOf(issues: readonly GitHubIssue[], base: string, defaultBranch: string): string {
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
 * The GitHub issue tracker source: the issues the pull request links —
 * closing references, sidebar links and issues in other repositories —
 * read with the request's token. Issues GitHub will not give are an
 * unreadable outcome saying why, never a failed review.
 */
export function gitHubIssues(client: GitHubClient): IssueTrackerSource {
  return {
    source: 'github',
    async readLinkedIssues({ ref, base }) {
      let linked: Awaited<ReturnType<GitHubClient['getLinkedIssues']>>;
      try {
        linked = await client.getLinkedIssues(ref);
      } catch (error) {
        return { issues: [], outcome: 'unreadable', detail: `the linked issues could not be read: ${reason(error)}` };
      }
      return {
        issues: linked.issues.map((issue) => sourced(ref, issue)),
        outcome: 'read',
        detail: detailOf(linked.issues, base, linked.defaultBranch),
      };
    },
  };
}

/**
 * Criteria as a version-25 result kept them, before linked issues named
 * their source: every issue was GitHub's, and the one read was GitHub's.
 */
export type UnsourcedCriteria = Omit<Criteria, 'issues' | 'sources' | 'keyReferences'> & {
  issues: (GitHubIssue | LinkedIssue)[];
  sources?: IssueSourceRead[];
  keyReferences?: KeyReference[];
};

/**
 * Criteria kept before linked issues named their source, read as they
 * are kept now: each issue without a source is GitHub's, with the key it
 * is shown by in the pull request's repository, and the read is
 * GitHub's, with the criteria's outcome and detail. Criteria that
 * already name their sources are kept as they are.
 */
export function withIssueSources(criteria: UnsourcedCriteria, ref: Pick<PullRequestRef, 'owner' | 'repo'>): UnkeyedCriteria {
  const issues = criteria.issues.map((issue): LinkedIssue => ('source' in issue ? issue : { source: 'github', key: gitHubKey(ref, issue), ...issue }));
  const sources = criteria.sources ?? [{ source: 'github', outcome: criteria.outcome, detail: criteria.detail }];
  return { ...criteria, sources, issues };
}
