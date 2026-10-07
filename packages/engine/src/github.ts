import { Octokit } from '@octokit/rest';
import type { PositionedComment } from './positions.js';
import type {
  CheckAnnotation,
  LinkedIssue,
  PullRequestSummary,
  SentReview,
  SubmitKind,
} from './protocol.js';

/** The parts of a pull request URL the engine needs. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parses a GitHub pull request URL, such as
 * `https://github.com/owner/repo/pull/12` (any trailing path like `/files`
 * is ignored). Returns null for anything else.
 */
export function parsePullRequestUrl(input: string): PullRequestRef | null {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:\/.*)?$/.exec(
    input,
  );
  if (!match) {
    return null;
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export interface GitHubClientOptions {
  /** GitHub token, passed in by the caller; never stored or logged. */
  token: string;
  /**
   * Fetch implementation the client uses. Tests inject a fixture-backed
   * fetch here so no test ever touches the network.
   */
  fetch?: typeof fetch;
}

/** A logger that writes nothing, so no request detail can reach any log. */
const silentLog = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

/**
 * The engine's view of GitHub, through the official client: read for the
 * review, its checks and their failed jobs' logs included, and one write
 * — submitting the review — when the reviewer sends it (ADR 0002), besides
 * marking files "Viewed" when the reviewer's opt-in setting mirrors their
 * reviewed marks there.
 *
 * The token lives only in the Octokit instance's memory: the client writes
 * it nowhere and echoes it in no error or log line.
 */
export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(options: GitHubClientOptions) {
    this.octokit = new Octokit({
      auth: options.token,
      log: silentLog,
      ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    });
  }

  /**
   * Fetches the pull request's metadata. The description comes from
   * `data.body` in full; the engine never truncates it.
   */
  async getPullRequestSummary(ref: PullRequestRef): Promise<PullRequestSummary> {
    return (await this.getPullRequest(ref)).summary;
  }

  /**
   * Fetches the pull request's metadata and the merge commit GitHub made
   * for it, which its checks run on; null when GitHub has made none.
   */
  async getPullRequest(ref: PullRequestRef): Promise<{ summary: PullRequestSummary; mergeCommit: string | null }> {
    const { data } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    const summary: PullRequestSummary = {
      url: data.html_url,
      number: data.number,
      title: data.title,
      author: data.user?.login ?? '',
      description: data.body ?? '',
      base: data.base.ref,
      head: data.head.ref,
      baseCommit: data.base.sha,
      headSha: data.head.sha,
    };
    return { summary, mergeCommit: data.merge_commit_sha ?? null };
  }

  /** Lists every check run GitHub reports at one commit, in its order. */
  async listCheckRuns(ref: PullRequestRef, sha: string): Promise<CheckRunListing[]> {
    const runs = await this.octokit.paginate(this.octokit.checks.listForRef, {
      owner: ref.owner,
      repo: ref.repo,
      ref: sha,
      per_page: 100,
    });
    return runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url ?? run.details_url ?? '',
      annotations: run.output.annotations_count,
      app: run.app?.slug ?? null,
    }));
  }

  /** Reads the annotations one check run left, up to {@link MAX_ANNOTATIONS}. */
  async listAnnotations(ref: PullRequestRef, checkRunId: number): Promise<CheckAnnotation[]> {
    const { data } = await this.octokit.checks.listAnnotations({
      owner: ref.owner,
      repo: ref.repo,
      check_run_id: checkRunId,
      per_page: MAX_ANNOTATIONS,
    });
    return data.map((annotation) => {
      // The bundled API description types an annotation's lines as always
      // present; GitHub leaves both null on a file-level annotation.
      const startLine = annotation.start_line as number | null;
      const endLine = annotation.end_line as number | null;
      return {
        path: annotation.path,
        ...(startLine === null ? {} : { startLine }),
        ...(endLine === null ? {} : { endLine }),
        level: annotation.annotation_level === 'failure' || annotation.annotation_level === 'warning' ? annotation.annotation_level : 'notice',
        message: annotation.message ?? '',
        ...(annotation.title ? { title: annotation.title } : {}),
      };
    });
  }

  /**
   * Downloads one GitHub Actions job's plain-text log; a check run of
   * GitHub Actions has its job's id. Called only for a job that failed.
   */
  async downloadJobLog(ref: PullRequestRef, jobId: number): Promise<string> {
    const response = await this.octokit.actions.downloadJobLogsForWorkflowRun({
      owner: ref.owner,
      repo: ref.repo,
      job_id: jobId,
    });
    const data: unknown = response.data;
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    throw new Error(`the log of job ${jobId} arrived without a body`);
  }

  /**
   * Reads the issues the pull request links, through GitHub's GraphQL
   * side, with one query: the closing references — which cover the
   * description's closing keywords and the sidebar's "will close"
   * links, in this repository or another, and which GitHub returns only
   * for a pull request into the repository's default branch — and the
   * issues the pull request's own timeline shows referencing it, a
   * sidebar link or a mention. An issue both closes and is referenced
   * reads once, as a closing reference. Nothing is written.
   */
  async getLinkedIssues(ref: PullRequestRef): Promise<LinkedReferences> {
    const answer = linkedAnswer(
      await this.requestGraphql(LINKED_ISSUES_QUERY, {
        owner: ref.owner,
        name: ref.repo,
        number: ref.number,
      }),
    );
    const pullRequest = answer.repository?.pullRequest;
    const branch = answer.repository?.defaultBranchRef?.name;
    const issues: LinkedIssue[] = [];
    const seen = new Set<string>();
    for (const node of pullRequest?.closingIssuesReferences?.nodes ?? []) {
      const issue = linkedIssue(node, 'closes');
      if (issue === undefined) continue;
      seen.add(`${issue.repository}#${issue.number}`);
      issues.push(issue);
    }
    for (const node of pullRequest?.timelineItems?.nodes ?? []) {
      const issue = linkedIssue(node?.source, 'references');
      if (issue === undefined || seen.has(`${issue.repository}#${issue.number}`)) continue;
      issues.push(issue);
    }
    return { defaultBranch: typeof branch === 'string' ? branch : '', issues };
  }

  /**
   * Sends one GraphQL query through the same client, so it carries the
   * same token, the same silent log and the same fetch as every REST
   * call, and hands back its parsed answer as it arrived: the envelope
   * with the query's `data` and any `errors`, so a query that failed —
   * GitHub answers some failures as HTTP 200 with `data: null` — is
   * seen by whoever reads the answer.
   */
  private async requestGraphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const response: { data: unknown } = await this.octokit.request('POST /graphql', { query, variables });
    return response.data;
  }

  /**
   * Finds the merge base of the base and head commits: the version the
   * pull request's diff is computed against, so the base copy is taken
   * there rather than at the moving tip of the base branch.
   */
  async getMergeBase(ref: PullRequestRef, base: string, head: string): Promise<string> {
    const { data } = await this.octokit.repos.compareCommitsWithBasehead({
      owner: ref.owner,
      repo: ref.repo,
      basehead: `${base}...${head}`,
      per_page: 1,
    });
    return data.merge_base_commit.sha;
  }

  /**
   * Fetches the diff a head commit makes against its merge base with a
   * base commit, the way the pull request's own diff is taken; null when
   * GitHub cannot serve the comparison: it no longer has either commit,
   * such as one a force-push left behind, or the two share no history.
   */
  async getChangeDiff(ref: PullRequestRef, base: string, head: string): Promise<string | null> {
    let response;
    try {
      response = await this.octokit.repos.compareCommitsWithBasehead({
        owner: ref.owner,
        repo: ref.repo,
        basehead: `${base}...${head}`,
        mediaType: { format: 'diff' },
      });
    } catch (error) {
      if (isNotFound(error) || (error as { status?: unknown }).status === 422) return null;
      throw error;
    }
    return diffText(response.data);
  }

  /**
   * The commit and time of the signed-in reviewer's last submitted review
   * of the pull request; null when they have submitted none. A pending
   * review is not submitted, so it never counts.
   */
  async getLastReviewedCommit(ref: PullRequestRef): Promise<{ commit: string; at: string } | null> {
    const { data: user } = await this.octokit.users.getAuthenticated();
    const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });
    const last = reviews
      .filter((review) => review.user?.login === user.login && review.state !== 'PENDING' && review.commit_id && review.submitted_at)
      .at(-1);
    return last === undefined ? null : { commit: last.commit_id!, at: last.submitted_at! };
  }

  /**
   * Streams the gzipped tarball of one commit. The archive is downloaded,
   * never checked out, and the body is handed over unparsed so a large
   * repository is never held in memory whole.
   */
  async downloadTarball(ref: PullRequestRef, commit: string): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.octokit.repos.downloadTarballArchive({
      owner: ref.owner,
      repo: ref.repo,
      ref: commit,
      request: { parseSuccessResponseBody: false },
    });
    const body: unknown = response.data;
    if (body instanceof ReadableStream) {
      return body as ReadableStream<Uint8Array>;
    }
    throw new Error(`the archive of ${commit} arrived without a body`);
  }

  /**
   * Fetches the pull request's full diff. Requesting the diff media type
   * returns the complete patch even when a file is too large for the REST
   * file list to include its `patch`, so a big lockfile keeps every line.
   */
  async getPullRequestDiff(ref: PullRequestRef): Promise<string> {
    const response = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      mediaType: { format: 'diff' },
    });
    return diffText(response.data);
  }

  /**
   * Submits the pending review to GitHub as one review: every comment in
   * it, the overall body when there is one, and the kind the reviewer
   * chose, on the commit the diff the comments were mapped against was
   * taken at. One request carries it all — nothing reaches GitHub before
   * it — and the answer carries the review's link.
   */
  async submitReview(
    ref: PullRequestRef,
    review: {
      /** The head commit whose diff the comments' positions were mapped against. */
      commitId: string;
      submit: SubmitKind;
      body?: string;
      comments: PositionedComment[];
    },
  ): Promise<SentReview> {
    const { data } = await this.octokit.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      commit_id: review.commitId,
      ...(review.body !== undefined ? { body: review.body } : {}),
      event: SUBMIT_EVENTS[review.submit],
      // The bundled API description predates file-anchored comments
      // (subject_type) on this endpoint, so the request carries them past
      // the generated types; GitHub accepts the field.
      comments: review.comments.map((comment) => ({
        path: comment.path,
        body: comment.body,
        ...(comment.position !== undefined
          ? { position: comment.position }
          : { subject_type: 'file' }),
      })) as NonNullable<Parameters<typeof this.octokit.pulls.createReview>[0]>['comments'],
    });
    return { url: data.html_url };
  }

  /**
   * Marks files of the pull request "Viewed" on GitHub, the field the
   * GitHub Pull Requests extension syncs too: one GraphQL mutation per
   * path, after one query for the pull request's id. Only the reviewer's
   * opt-in setting asks for it, and only for files whose every part they
   * reviewed. Nothing is ever unmarked.
   */
  async markFilesAsViewed(ref: PullRequestRef, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const answer = graphqlData(
      await this.requestGraphql(PULL_REQUEST_ID_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number }),
      'pull-request-id query',
    ) as { repository?: { pullRequest?: { id?: unknown } | null } | null };
    const id = answer.repository?.pullRequest?.id;
    if (typeof id !== 'string') throw new Error(`GitHub has no pull request ${ref.owner}/${ref.repo}#${ref.number}`);
    for (const path of paths) {
      graphqlData(await this.requestGraphql(MARK_FILE_AS_VIEWED_MUTATION, { id, path }), 'mark-as-viewed mutation');
    }
  }

  /**
   * Reads the repository's root `.gitattributes` as stored at the given
   * commit, without a checkout: the contents endpoint serves the blob at
   * that ref. Returns null when the repository has no such file; any other
   * failure propagates.
   */
  async getGitAttributesAt(ref: PullRequestRef, sha: string): Promise<string | null> {
    let data;
    try {
      ({ data } = await this.octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: '.gitattributes',
        ref: sha,
      }));
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      !Array.isArray(data) &&
      data.type === 'file' &&
      typeof data.content === 'string' &&
      data.encoding === 'base64'
    ) {
      // GitHub inlines the blob's base64 with line breaks; drop them.
      const encoded = data.content.replace(/\s+/g, '');
      return Buffer.from(encoded, 'base64').toString('utf8');
    }
    return null; // Symlinks, directories, or files too large to inline.
  }
}

/** The most annotations the companion reads of one check run. */
const MAX_ANNOTATIONS = 50;

/** The most closing issues one query reads; a pull request closing more lists none beyond these. */
const MAX_CLOSING_ISSUES = 50;

/** The most cross-references one query reads from the pull request's own timeline. */
const MAX_TIMELINE_LINKS = 100;

/**
 * The issues the pull request links, with the repository's default
 * branch: GitHub returns closing references only for a pull request
 * into that branch, so a review needs the branch to say why none came
 * back.
 */
export interface LinkedReferences {
  /** The repository's default branch, as the answer names it. */
  defaultBranch: string;
  /** The linked issues: closing references first, then the issues referencing the pull request, in GitHub's order. */
  issues: LinkedIssue[];
}

/**
 * The query that reads the pull request's closing references and the
 * issues referencing it in one GraphQL round trip. The closing
 * references cover the description's closing keywords and the sidebar's
 * "will close" links, in this repository or another; the timeline's
 * cross-references are the issues that reference the pull request
 * without closing, such as a plain sidebar link.
 */
const LINKED_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      closingIssuesReferences(first: ${MAX_CLOSING_ISSUES}) {
        nodes { number title url body repository { nameWithOwner } }
      }
      timelineItems(first: ${MAX_TIMELINE_LINKS}, itemTypes: CROSS_REFERENCED_EVENT) {
        nodes { ... on CrossReferencedEvent { source { ... on Issue { number title url body repository { nameWithOwner } } } } }
      }
    }
  }
}`;

/** A GraphQL answer that failed, with the message of its first error. */
function linkedAnswer(response: unknown): GraphQLData {
  return graphqlData(response, 'linked-issues query') as GraphQLData;
}

/** A GraphQL answer's data, or a plain error naming the request when GitHub reports one. */
function graphqlData(response: unknown, request: string): unknown {
  const body = (response as GraphQLAnswer) ?? {};
  const errors = body.errors;
  if (errors !== undefined && errors.length > 0) {
    const message = errors[0]?.message;
    throw new Error(
      `GitHub's ${request} failed${typeof message === 'string' ? `: ${message}` : ''}`,
    );
  }
  return body.data ?? {};
}

/** The query that reads the pull request's GraphQL id, which the mark-as-viewed mutation names it by. */
const PULL_REQUEST_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

/** The mutation that marks one file of the pull request "Viewed" for the signed-in reviewer. */
const MARK_FILE_AS_VIEWED_MUTATION = `mutation($id: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}`;

/** One linked issue, read defensively: anything GitHub leaves out reads as absent. */
function linkedIssue(node: unknown, link: LinkedIssue['link']): LinkedIssue | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const value = node as Record<string, unknown>;
  const repository =
    typeof value['repository'] === 'object' && value['repository'] !== null
      ? (value['repository'] as { nameWithOwner?: unknown }).nameWithOwner
      : undefined;
  if (
    typeof value['number'] !== 'number' ||
    typeof value['title'] !== 'string' ||
    typeof value['url'] !== 'string' ||
    typeof repository !== 'string'
  ) {
    return undefined;
  }
  return {
    number: value['number'],
    title: value['title'],
    url: value['url'],
    repository,
    body: typeof value['body'] === 'string' ? value['body'] : '',
    link,
  };
}

/** The data the linked-issues query asks for, each field optional as GitHub leaves it. */
interface GraphQLData {
  repository?: {
    defaultBranchRef?: { name?: unknown };
    pullRequest?: {
      closingIssuesReferences?: { nodes?: unknown[] };
      timelineItems?: { nodes?: ({ source?: unknown } | undefined)[] };
    };
  };
}

/**
 * The envelope one GraphQL query answers with: the query's data, and
 * the errors that make it fail — a rate limit or a permission error
 * among them — which GitHub can send with HTTP 200 and `data: null`.
 */
interface GraphQLAnswer {
  errors?: { message?: unknown }[];
  data?: GraphQLData | null;
}

/** One check run as GitHub lists it, before its annotations and log are read. */
export interface CheckRunListing {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** The check run's page on GitHub. */
  url: string;
  /** How many annotations it left. */
  annotations: number;
  /** The app that ran it, such as `github-actions`; null when GitHub names none. */
  app: string | null;
}

/** A diff as text: the diff media type is not JSON, so the client hands over raw bytes. */
function diffText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data);
}

/** True when the error is the endpoint's plain 404. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404
  );
}

/** How each submit kind reads on GitHub's wire. */
const SUBMIT_EVENTS: Record<SubmitKind, 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'> = {
  comment: 'COMMENT',
  approve: 'APPROVE',
  'request changes': 'REQUEST_CHANGES',
};
