import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PR_URL = 'https://github.com/example-org/example-repo/pull/42';

/** One request the fake transport served, with the headers we care about. */
export interface RecordedRequest {
  url: string;
  accept: string;
  authorization: string | null;
}

export interface FixtureTransport {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

/**
 * A fetch that serves the recorded GitHub responses from test/fixtures:
 * the JSON metadata for plain requests, the full diff for requests that ask
 * for the diff media type. Any other URL throws, so a test can never touch
 * the live network by accident.
 */
export function fixtureFetch(): FixtureTransport {
  const requests: RecordedRequest[] = [];
  const fetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      accept: headers.get('accept') ?? '',
      authorization: headers.get('authorization'),
    });
    if (url !== 'https://api.github.com/repos/example-org/example-repo/pulls/42') {
      throw new Error(
        `unexpected request to ${url}: tests run against recorded responses only`,
      );
    }
    const wantsDiff = (headers.get('accept') ?? '').includes('vnd.github.v3.diff');
    const name = wantsDiff ? './fixtures/pull-42.diff' : './fixtures/pull-42.json';
    const body = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': wantsDiff
          ? 'application/vnd.github.v3.diff'
          : 'application/json; charset=utf-8',
      },
    });
  };
  return { fetch, requests };
}

/** A fetch that always fails with the given error. */
export function failingFetch(error: Error): typeof fetch {
  return async () => {
    throw error;
  };
}

/** Captures everything written to it, in place of a process stream. */
export class CaptureStream {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join('');
  }
}
