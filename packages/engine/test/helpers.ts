import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { AgentAdapter, AgentProbe, AgentRunRequest } from '../src/agent.js';
import { parseDiff } from '../src/diff.js';
import { readZipEntries } from '../src/zip.js';
import type { ChangeKind, DiffLine, Part } from '../src/protocol.js';

export const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
export const PR_7_URL = 'https://github.com/example-org/example-repo/pull/7';
export const PR_8_URL = 'https://github.com/example-org/example-repo/pull/8';
export const PR_9_URL = 'https://github.com/example-org/example-repo/pull/9';

const GITATTRIBUTES_URL =
  'https://api.github.com/repos/example-org/example-repo/contents/.gitattributes';

/** One request the fake transport served, with the headers we care about. */
export interface RecordedRequest {
  url: string;
  /** The request's HTTP method, so a test can prove which calls wrote. */
  method: string;
  /** The request body, parsed when it is JSON; null when there was none. */
  body: unknown;
  accept: string;
  authorization: string | null;
}

export interface FixtureTransport {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

/** A recorded pull request: its metadata, its diff, and both versions' files. */
export interface PullFixture {
  number: number;
  /** Fixture file of the metadata JSON. */
  json: string;
  /** Fixture file of the full diff. */
  diff: string;
  /** Head commit, as the metadata names it. */
  headSha: string;
  /** The merge base the compare endpoint reports. */
  mergeBase: string;
  base: Record<string, string>;
  head: Record<string, string>;
  /** Whether the recorded CI in `fixtures/ci` is served at the head commit; no check runs otherwise. */
  ci?: boolean;
  /**
   * Fixture file of the recorded GraphQL answer for the pull request's
   * linked issues, under `fixtures/issues`; when absent, an answer that
   * names the default branch master and links no issue is served.
   */
  issues?: string;
}

function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

/** Every file under a fixture folder, by its forward-slash path. */
function fixtureTree(name: string): Record<string, string> {
  const root = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    files[relative(root, absolute).split(sep).join('/')] = readFileSync(absolute, 'utf8');
  }
  return files;
}

/**
 * Rebuilds the two versions of each file from a diff alone: the hunk lines
 * at their line numbers, with the same filler on both sides for the lines
 * the diff does not show.
 */
export function versionsFromDiff(
  diff: string,
): { base: Record<string, string>; head: Record<string, string> } {
  const base: Record<string, string> = {};
  const head: Record<string, string> = {};
  for (const part of parseDiff(diff).files) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const hunk of part.hunks) {
      while (oldLines.length < hunk.oldStart - 1) oldLines.push('unchanged');
      while (newLines.length < hunk.newStart - 1) newLines.push('unchanged');
      for (const line of hunk.lines) {
        if (line.kind !== 'addition') oldLines.push(line.text);
        if (line.kind !== 'deletion') newLines.push(line.text);
      }
    }
    const ending = (missing: boolean): string => (missing ? '' : '\n');
    if (part.changeKind !== 'addition') {
      base[part.previousPath ?? part.path] = part.isBinary
        ? 'binary base'
        : oldLines.join('\n') + ending(part.oldMissingFinalNewline);
    }
    if (part.changeKind !== 'deletion') {
      head[part.path] = part.isBinary
        ? 'binary head'
        : newLines.join('\n') + ending(part.newMissingFinalNewline);
    }
  }
  return { base, head };
}

/** Pull request 42: dependency updates, a rename, a binary and a big lockfile. */
export function pull42(): PullFixture {
  const diff = 'pull-42.diff';
  return {
    number: 42,
    json: 'pull-42.json',
    diff,
    headSha: 'f00dcafe1234567890abcdef1234567890abcdef',
    mergeBase: '4242424242424242424242424242424242424242',
    issues: 'issues/pull-42-issues.json',
    ...versionsFromDiff(fixtureText(diff)),
  };
}

/** Pull request 7: a Python reformat, a behaviour-changing dedent, a C# restyle and more. */
export function pull7(): PullFixture {
  return {
    number: 7,
    json: 'pull-7.json',
    diff: 'pull-7.diff',
    headSha: '7777777777777777777777777777777777777777',
    mergeBase: '6666666666666666666666666666666666666666',
    base: fixtureTree('pull-7/base'),
    head: fixtureTree('pull-7/head'),
  };
}

/**
 * Pull request 8: a package.json bump its package-lock.json follows
 * (confirmed noise), a hand-edited poetry.lock entry with an unchanged
 * pyproject.toml (claimed noise, the entry named), and a yarn.lock no
 * check exists for (claimed noise, no check for this lockfile).
 */
export function pull8(): PullFixture {
  return {
    number: 8,
    json: 'pull-8.json',
    diff: 'pull-8.diff',
    headSha: '8888888888888888888888888888888888888888',
    mergeBase: '7777777777777777777777777777777777777776',
    base: fixtureTree('pull-8/base'),
    head: fixtureTree('pull-8/head'),
  };
}

/**
 * Pull request 9: an npm workspaces root bump whose lock file check
 * reads a member package.json that is committed broken, so the review
 * reports no check while it names the member's manifest.
 */
export function pull9(): PullFixture {
  return {
    number: 9,
    json: 'pull-9.json',
    diff: 'pull-9.diff',
    headSha: '9999999999999999999999999999999999999999',
    mergeBase: '9999999999999999999999999999999999999998',
    base: fixtureTree('pull-9/base'),
    head: fixtureTree('pull-9/head'),
  };
}

/** One entry of a hand-built tar archive. */
export interface TarEntry {
  path: string;
  content?: string | Buffer;
  /** Tar type flag: '0' file, '2' symbolic link, '5' folder, 'x' and 'g' pax headers. */
  type?: string;
  linkName?: string;
}

/** A pax extended header record, whose length counts itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length++;
  return `${length}${body}`;
}

/** Builds a gzipped ustar archive of the given entries. */
export function tarball(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const octal = (value: number, width: number): string =>
    `${value.toString(8).padStart(width - 1, '0')}\0`;
  for (const entry of entries) {
    const body = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.path.slice(0, 100), 0, 'utf8');
    header.write(octal(0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(body.length, 12), 124);
    header.write(octal(0, 12), 136);
    header.write(' '.repeat(8), 148);
    header.write(entry.type ?? '0', 156);
    header.write(entry.linkName ?? '', 157);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A commit archive laid out as GitHub serves one: a pax comment, then one top folder. */
export function githubTarball(files: Record<string, string>, commit: string): Buffer {
  const top = `example-org-example-repo-${commit.slice(0, 7)}`;
  return tarball([
    { path: 'pax_global_header', type: 'g', content: paxRecord('comment', commit) },
    { path: `${top}/`, type: '5' },
    ...Object.entries(files).map(([path, content]) => ({ path: `${top}/${path}`, content })),
  ]);
}

const API = 'https://api.github.com/repos/example-org/example-repo';

/** The one GraphQL endpoint GitHub serves every query at. */
const GRAPHQL_URL = 'https://api.github.com/graphql';

/**
 * The answer every fixture serves for the linked-issues query when the
 * pull request records none: the default branch master and no linked
 * issue.
 */
const NO_LINKED_ISSUES = {
  data: {
    repository: {
      defaultBranchRef: { name: 'master' },
      pullRequest: {
        closingIssuesReferences: { nodes: [] },
        timelineItems: { nodes: [] },
      },
    },
  },
};

/** The review the recorded responses hand back for a send. */
export const SENT_REVIEW_URL = `${PR_URL}#pullrequestreview-4242`;

/** Reads the body a request carried, parsed when it is JSON. */
function recordedBody(init: RequestInit | undefined): unknown {
  const raw = init?.body;
  if (typeof raw !== 'string' || raw === '') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * A fetch that serves the recorded GitHub responses from test/fixtures:
 * the JSON metadata for plain requests, the full diff for requests that ask
 * for the diff media type, the repository's root `.gitattributes` as
 * stored at the head commit, the merge base from the compare endpoint,
 * the linked issues from the one GraphQL query the review makes, archives
 * of both versions, the check runs at the head commit with their
 * annotations and the failed job's log when the fixture records CI, the
 * signed-in reviewer with no review submitted yet, a 404 for the change
 * at any earlier commit, and one submitted review for a send. Any
 * other URL throws, so a test can never touch the live network by
 * accident.
 */
export function fixtureFetch(pull: PullFixture = pull42()): FixtureTransport {
  const requests: RecordedRequest[] = [];
  const meta = JSON.parse(fixtureText(pull.json)) as { base: { sha: string } };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: recordedBody(init),
      accept: headers.get('accept') ?? '',
      authorization: headers.get('authorization'),
    });
    if (url === `${GITATTRIBUTES_URL}?ref=${pull.headSha}`) {
      // Only pull request 42's repository records linguist attributes; a
      // repository without the file answers 404, and the client reads that
      // as no attributes.
      if (pull.number !== 42) {
        return Response.json({ message: 'Not Found' }, { status: 404 });
      }
      const body = readFileSync(
        fileURLToPath(new URL('./fixtures/pull-42.gitattributes', import.meta.url)),
        'utf8',
      );
      return new Response(
        JSON.stringify({
          name: '.gitattributes',
          path: '.gitattributes',
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(body, 'utf8').toString('base64'),
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    }
    if (url === GRAPHQL_URL) {
      // The linked-issues query is the only GraphQL the review makes; the
      // recorded answer serves it whatever its variables are.
      const body = pull.issues === undefined ? NO_LINKED_ISSUES : JSON.parse(fixtureText(pull.issues));
      return Response.json(body);
    }
    // The reviewer has submitted no review, so a first look compares with nothing.
    if (url === 'https://api.github.com/user') return Response.json({ login: 'reviewer' });
    if (url === `${API}/pulls/${pull.number}/reviews?per_page=100`) return Response.json([]);
    if (url === `${API}/pulls/${pull.number}/reviews`) {
      if ((init?.method ?? 'GET') !== 'POST') {
        throw new Error(`unexpected ${init?.method ?? 'GET'} to ${url}: sending is one POST`);
      }
      return Response.json({ id: 4242, html_url: SENT_REVIEW_URL, state: 'COMMENTED' });
    }
    if (url === `${API}/pulls/${pull.number}`) {
      const wantsDiff = (headers.get('accept') ?? '').includes('vnd.github.v3.diff');
      return new Response(fixtureText(wantsDiff ? pull.diff : pull.json), {
        status: 200,
        headers: {
          'content-type': wantsDiff
            ? 'application/vnd.github.v3.diff'
            : 'application/json; charset=utf-8',
        },
      });
    }
    if (url === `${API}/commits/${pull.headSha}/check-runs?per_page=100`) {
      if (!pull.ci) return Response.json({ total_count: 0, check_runs: [] });
      return new Response(fixtureText('ci/check-runs.json'), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    const annotations = /\/check-runs\/(\d+)\/annotations\?per_page=50$/.exec(url);
    if (pull.ci && url.startsWith(`${API}/check-runs/`) && annotations) {
      return new Response(fixtureText(`ci/annotations-${annotations[1]}.json`), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    // GitHub answers the job's log with a redirect to its storage; fetch
    // follows it, so the recorded answer is the log itself.
    if (pull.ci && url === `${API}/actions/jobs/9001/logs`) {
      return new Response(fixtureText('ci/job-9001.log'), { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (url === `${API}/compare/${meta.base.sha}...${pull.headSha}?per_page=1`) {
      return Response.json({ merge_base_commit: { sha: pull.mergeBase } });
    }
    // The change at any earlier commit: GitHub no longer has it.
    if (new RegExp(`^${API}/compare/[0-9a-f]+\\.\\.\\.[0-9a-f]+$`).test(url)) {
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    const tarballMatch = /\/tarball\/([0-9a-f]+)$/.exec(url);
    if (url.startsWith(`${API}/tarball/`) && tarballMatch) {
      const commit = tarballMatch[1]!;
      const files =
        commit === pull.mergeBase ? pull.base : commit === pull.headSha ? pull.head : undefined;
      if (files) {
        return new Response(githubTarball(files, commit), {
          status: 200,
          headers: { 'content-type': 'application/x-gzip' },
        });
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    throw new Error(`unexpected request to ${url}: tests run against recorded responses only`);
  };
  return { fetch: fetchImpl, requests };
}

/** A fresh, empty cache folder; remove it with `removeCopy`. */
export function temporaryCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'second-look-cache-'));
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

/**
 * A one-hunk part for the syntax pass: the given base lines removed and
 * head lines added, each with its text taken from that side's source.
 */
export function changedPart(options: {
  path: string;
  base?: string;
  head?: string;
  deleted?: number[];
  added?: number[];
  changeKind?: ChangeKind;
}): Part {
  const baseLines = options.base?.split('\n') ?? [];
  const headLines = options.head?.split('\n') ?? [];
  const lines: DiffLine[] = [
    ...(options.deleted ?? []).map((line): DiffLine => ({
      kind: 'deletion',
      oldLineNumber: line,
      text: baseLines[line - 1]!,
    })),
    ...(options.added ?? []).map((line): DiffLine => ({
      kind: 'addition',
      newLineNumber: line,
      text: headLines[line - 1]!,
    })),
  ];
  return {
    path: options.path,
    changeKind: options.changeKind ?? 'modification',
    isBinary: false,
    oldMissingFinalNewline: false,
    newMissingFinalNewline: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines, entities: [] }],
    additions: options.added?.length ?? 0,
    deletions: options.deleted?.length ?? 0,
    syntax: { formattingOnly: { status: 'not-checked', reason: '' }, checksNotRun: [] },
  };
}

export interface ScriptedAgent extends AgentAdapter {
  /** The requests the agent was run with, in order. */
  requests: AgentRunRequest[];
}

/** An agent that answers each run with the next scripted text, recording each request. */
export function scriptedAgent(answers: readonly string[], probe: Partial<AgentProbe> = {}): ScriptedAgent {
  const requests: AgentRunRequest[] = [];
  return {
    agent: 'fake',
    requests,
    probe: async () => ({
      agent: 'fake',
      version: '1.2.3',
      installed: true,
      usable: true,
      supports: { effort: false },
      effortLevels: [],
      lockdown: [],
      ...probe,
    }),
    run: async (request) => {
      requests.push(request);
      return {
        status: 'completed',
        text: answers[requests.length - 1] ?? '',
        stamp: {
          agent: 'fake',
          agentVersion: '1.2.3',
          model: 'fake/model',
          effort: null,
          runAt: '2026-10-02T00:00:00.000Z',
        },
      };
    },
  };
}

/**
 * An agent that answers each run with what `answer` makes of the request,
 * such as a grouping or a ranking built from the prompt, recording each
 * request.
 */
export function answeringAgent(
  answer: (request: AgentRunRequest) => unknown,
  model = 'fake/model',
  effort: string | null = null,
): ScriptedAgent {
  const scripted = scriptedAgent([]);
  return {
    ...scripted,
    run: async (request) => {
      scripted.requests.push(request);
      return {
        status: 'completed',
        text: JSON.stringify(answer(request)),
        stamp: { agent: 'fake', agentVersion: '1.2.3', model, effort, runAt: '2026-10-04T00:00:00.000Z' },
      };
    },
  };
}

/** The parts a ranking prompt offers, in its order: each id with the part's name. */
export function offeredParts(prompt: string): { id: string; name: string }[] {
  return [...prompt.matchAll(/^\[(p\d+)\] signals: .*\n<untrusted-input [^\n]*\nname: (.*)$/gm)].map((match) => ({
    id: match[1]!,
    name: match[2]!,
  }));
}

/** One entry of a hand-built ZIP archive, such as a wheel's file. */
export interface ZipFixtureEntry {
  name: string;
  content?: string | Buffer;
  /** The Unix mode recorded for it: a regular file by default, `0o120777` for a symbolic link. */
  mode?: number;
}

/** Builds a ZIP archive of stored entries, made on Unix so each records its mode. */
export function zipArchive(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = Buffer.from(entry.content ?? '');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The SHA-256 of some bytes, as lowercase hex. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One file a recorded PyPI release lists, with the bytes its download serves. */
export interface PyPIFixtureFile {
  filename: string;
  bytes: Buffer;
  /** The download's URL; PyPI's own file host by default. */
  url?: string;
  /** The SHA-256 PyPI lists for it; the bytes' own by default. */
  sha256?: string;
}

/**
 * A fetch that serves one recorded PyPI release: its JSON API answer
 * listing the files, and each file's download. Any other URL throws, so a
 * test can never touch the live network by accident.
 */
export function pypiFetch(name: string, version: string, files: readonly PyPIFixtureFile[]): FixtureTransport {
  const requests: RecordedRequest[] = [];
  const listed = files.map((file) => ({
    ...file,
    url: file.url ?? `https://files.pythonhosted.org/packages/ab/cd/${file.filename}`,
  }));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? 'GET', body: null, accept: new Headers(init?.headers).get('accept') ?? '', authorization: null });
    if (url === `https://pypi.org/pypi/${name}/${version}/json`) {
      return Response.json({
        urls: listed.map((file) => ({
          filename: file.filename,
          url: file.url,
          packagetype: file.filename.endsWith('.whl') ? 'bdist_wheel' : 'sdist',
          digests: { sha256: file.sha256 ?? sha256Hex(file.bytes) },
        })),
      });
    }
    const file = listed.find((each) => each.url === url);
    if (file) return new Response(file.bytes, { status: 200 });
    throw new Error(`unexpected request to ${url}: tests run against recorded responses only`);
  };
  return { fetch: fetchImpl, requests };
}

/**
 * A fetch that serves recorded downloads, by URL: each answers with its
 * bytes, and any other URL throws, so a test can never touch the live
 * network by accident. A URL recorded as `404` answers not found.
 */
export function recordedFetch(downloads: Readonly<Record<string, Buffer | string | 404>>): FixtureTransport {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? 'GET', body: null, accept: new Headers(init?.headers).get('accept') ?? '', authorization: null });
    const body = downloads[url];
    if (body === 404) return new Response('Not Found', { status: 404 });
    if (body !== undefined) return new Response(body, { status: 200 });
    throw new Error(`unexpected request to ${url}: tests run against recorded responses only`);
  };
  return { fetch: fetchImpl, requests };
}

/** Version 1.2.2 of RecyclableMemoryStream: assemblies with no Source Link, and a nuspec naming no commit and linking its licence. */
export const OLD_NUGET_PACKAGE = readFileSync(fileURLToPath(new URL('./fixtures/pdb/Microsoft.IO.RecyclableMemoryStream.1.2.2.nupkg', import.meta.url)));

/** Version 1.2.2 repacked with its nuspec's licence link replaced by `licence`, as a later version's licence may change. */
export function relicensed(licence: string): Buffer {
  return zipArchive(
    readZipEntries(OLD_NUGET_PACKAGE).map((entry) => ({
      name: entry.name,
      content: entry.name.endsWith('.nuspec') ? Buffer.from(entry.read()).toString('utf8').replace(/<licenseUrl>[^<]*<\/licenseUrl>/, licence) : Buffer.from(entry.read()),
    })),
  );
}
