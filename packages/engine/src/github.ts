import { Octokit } from '@octokit/rest';
import type { PositionedComment } from './positions.js';
import type { CheckAnnotation, PullRequestSummary, SentReview, SubmitKind } from './protocol.js';

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
 * — submitting the review — when the reviewer sends it (ADR 0002).
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
    return data.map((annotation) => ({
      path: annotation.path,
      startLine: annotation.start_line,
      endLine: annotation.end_line,
      level: annotation.annotation_level === 'failure' || annotation.annotation_level === 'warning' ? annotation.annotation_level : 'notice',
      message: annotation.message ?? '',
      ...(annotation.title ? { title: annotation.title } : {}),
    }));
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
    // The diff media type is not JSON; the client hands over raw bytes.
    if (typeof response.data === 'string') {
      return response.data;
    }
    if (response.data instanceof ArrayBuffer) {
      return new TextDecoder().decode(response.data);
    }
    return String(response.data);
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
