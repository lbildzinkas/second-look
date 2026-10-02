import { Octokit } from '@octokit/rest';
import type { PullRequestSummary } from './protocol.js';

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
 * The engine's read-only view of GitHub, through the official client.
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
    const { data } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    return {
      url: data.html_url,
      number: data.number,
      title: data.title,
      author: data.user?.login ?? '',
      description: data.body ?? '',
      base: data.base.ref,
      head: data.head.ref,
      headSha: data.head.sha,
    };
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

/** True when the error is the endpoint's plain 404. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404
  );
}
