import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, constants, readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import { trackAgentChild } from './agent-children.js';

/**
 * The sandboxed run (ADR 0009): the pull request's code at its head
 * commit, run only when the reviewer starts it, inside an OCI container
 * started through the Docker-compatible CLI the reviewer installed. The
 * container gets no host mount and no environment from the reviewer's
 * machine: the head copy streams in as a tar archive on stdin and is
 * unpacked into a tmpfs. The companion never installs, starts or
 * configures a runtime.
 */

/** The runtimes the companion drives, in the order it looks for them. */
export const SANDBOX_RUNTIMES = ['docker', 'podman'] as const;

export type SandboxRuntimeName = (typeof SANDBOX_RUNTIMES)[number];

/** The runtime CLI a sandboxed run goes through. */
export interface SandboxRuntime {
  name: SandboxRuntimeName;
  /** The CLI's absolute path, found on the PATH. */
  path: string;
  /** The version its daemon or machine reported. */
  version: string;
}

/** Whether a sandboxed run can happen, and through which runtime or why not. */
export type SandboxProbe = { usable: true; runtime: SandboxRuntime } | { usable: false; reason: string };

/** The resources one sandboxed run may take. */
export interface SandboxLimits {
  cpus: number;
  memoryMiB: number;
  pids: number;
  /** The tmpfs sizes: the copy's folder, `/tmp` and the home folder. */
  workMiB: number;
  tmpMiB: number;
  homeMiB: number;
  timeoutMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  cpus: 2,
  memoryMiB: 4096,
  pids: 512,
  workMiB: 1024,
  tmpMiB: 512,
  homeMiB: 256,
  timeoutMs: 10 * 60 * 1000,
};

/** The non-root user the code runs as: `nobody` in most images. */
export const SANDBOX_USER = '65534:65534';

/** Where the copy is unpacked, and the home folder the run gets; both tmpfs mounts. */
export const SANDBOX_WORK_DIR = '/work';
export const SANDBOX_HOME = '/home/second-look';

/**
 * The script the container starts with: it unpacks the copy from stdin
 * into `/work` and runs the command there, each word of it one argument,
 * with `HOME` on its own tmpfs. `--` is the script's `$0`.
 */
const UNPACK_AND_RUN = `export HOME=${SANDBOX_HOME} && tar -x -f - -C ${SANDBOX_WORK_DIR} && cd ${SANDBOX_WORK_DIR} && exec "$@"`;

/** An image pinned by digest: a name, an optional tag, then `@sha256:` and 64 hex digits. */
const PINNED_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

/** The problem with an image reference that is not pinned by digest; undefined when it is. */
export function imageProblem(image: string): string | undefined {
  if (PINNED_IMAGE.test(image)) return undefined;
  return `the image must be pinned by its digest, as name@sha256:<64 hex digits>, so the run uses exactly the image shown; got "${image}"`;
}

/** The longest output one run keeps: its last few KiB. */
const OUTPUT_TAIL_CHARS = 8 * 1024;

/** How long the version query, the pull and the kill may take. */
const VERSION_TIMEOUT_MS = 15_000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_TIMEOUT_MS = 15_000;

/** How the reviewer gets a runtime, as a missing or silent one's message says. */
const INSTALL_HINT =
  'Install Docker (https://docs.docker.com/get-started/get-docker/) or Podman (https://podman.io/docs/installation) to run it; the rest of the review works without one.';
const START_HINT: Record<SandboxRuntimeName, string> = {
  docker: 'Start Docker Desktop, or the Docker service, and try again.',
  podman: 'Start its machine with `podman machine start`, or its service, and try again.',
};

/**
 * The only variables the runtime's CLI is started with: the path, the
 * folders it keeps its own configuration in, and its connection
 * variables. None reaches the container, which is given no `-e` or
 * `--env-file`; this keeps the engine's other variables, such as a token,
 * out of the CLI too.
 */
const RUNTIME_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
  'CONTAINER_SSHKEY',
  'CONTAINERS_CONF',
  'CONTAINERS_REGISTRIES_CONF',
  'CONTAINERS_STORAGE_CONF',
];

/** The minimal environment the runtime's CLI is started with. */
export function runtimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const name of RUNTIME_ENV) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/** Starts the runtime's CLI; tests inject a fake so no unit test starts a process. */
export type StartRuntime = (program: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

const startRuntime: StartRuntime = (program, args, env) =>
  spawn(program, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

export interface SandboxDeps {
  /** The folders the runtime is looked for in: the PATH's when omitted. */
  dirs?: readonly string[];
  /** The environment the CLI's minimal one is taken from: the engine's when omitted. */
  env?: NodeJS.ProcessEnv;
  start?: StartRuntime;
  platform?: NodeJS.Platform;
}

/** The program's absolute path in the first folder that holds it as a runnable file; undefined when none does. */
async function findProgram(name: string, dirs: readonly string[], platform: NodeJS.Platform): Promise<string | undefined> {
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const path = join(dir, file);
    const runnable = await stat(path).then(
      async (found) => found.isFile() && (await access(path, constants.X_OK).then(() => true, () => false)),
      () => false,
    );
    if (runnable) return path;
  }
  return undefined;
}

/** Runs one short runtime command to its end, or stops it after `timeoutMs`, keeping the tail of its output. */
function runToEnd(
  start: StartRuntime,
  program: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child: ChildProcess;
    try {
      child = trackAgentChild(start(program, args, env));
    } catch (error) {
      resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdin?.end();
    const keep = (chunk: string): void => {
      output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.setEncoding('utf8').on('data', keep);
    child.stderr?.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => keep(`\n${error.message}`));
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
  });
}

/** The server version in the CLI's `version` answer; the client's for a Podman with no separate service. */
function serverVersion(name: SandboxRuntimeName, output: string): string | undefined {
  let answer: { Server?: { Version?: unknown } | null; Client?: { Version?: unknown } | null };
  try {
    answer = JSON.parse(output.slice(output.indexOf('{'))) as typeof answer;
  } catch {
    return undefined;
  }
  const server = answer.Server?.Version;
  if (typeof server === 'string' && server !== '') return server;
  const client = answer.Client?.Version;
  if (name === 'podman' && typeof client === 'string' && client !== '') return client;
  return undefined;
}

/**
 * Finds the runtime the reviewer installed — `docker`, then `podman`, on
 * the PATH — and asks its CLI for the server's version, to learn whether
 * a daemon or machine answers. A missing or silent runtime comes back
 * unusable, with a plain reason saying how to install or start one.
 */
export async function probeSandbox(deps: SandboxDeps = {}): Promise<SandboxProbe> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const dirs = deps.dirs ?? (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
  const start = deps.start ?? startRuntime;
  for (const name of SANDBOX_RUNTIMES) {
    const path = await findProgram(name, dirs, platform);
    if (path === undefined) continue;
    const { code, output } = await runToEnd(start, path, ['version', '--format', '{{json .}}'], runtimeEnv(env), VERSION_TIMEOUT_MS);
    const version = code === 0 ? serverVersion(name, output) : undefined;
    if (version === undefined) {
      const detail = output.split('\n').find((line) => line.trim() !== '');
      return {
        usable: false,
        reason: `${name} is installed but no ${name === 'docker' ? 'daemon' : 'machine or service'} answers, so the pull request's code cannot run. ${START_HINT[name]}${detail ? ` (${name} said: ${detail.trim()})` : ''}`,
      };
    }
    return { usable: true, runtime: { name, path, version } };
  }
  return { usable: false, reason: `Neither docker nor podman is on the PATH, so the pull request's code cannot run. ${INSTALL_HINT}` };
}

/** A new container name: `second-look-` and 12 random hex digits. */
export function sandboxName(): string {
  return `second-look-${randomBytes(6).toString('hex')}`;
}

export interface SandboxArgvRequest {
  /** The container's name, from {@link sandboxName}; the run is stopped by it. */
  name: string;
  /** The image, pinned by digest. */
  image: string;
  /** The command to run in the copy, one argument per word; no host shell reads it. */
  argv: readonly string[];
  limits?: SandboxLimits;
}

/** One tmpfs mount: in memory, writable by the run's user and allowed to run what a build writes. */
function tmpfs(path: string, sizeMiB: number): string[] {
  return ['--tmpfs', `${path}:rw,exec,nosuid,nodev,size=${sizeMiB}m,mode=1777`];
}

/**
 * The one `run` argv of a sandboxed run, as ADR 0009 sets it: no host
 * mount, no environment passed in, no network, a read-only root, every
 * capability dropped, no new privileges, a non-root user, limits on CPU,
 * memory with no swap on top and processes, and an image pinned by digest
 * that is never pulled here. Throws on an image without a digest or an
 * empty command.
 */
export function sandboxArgv(request: SandboxArgvRequest): string[] {
  const { name, image, argv } = request;
  const limits = request.limits ?? DEFAULT_SANDBOX_LIMITS;
  const problem = imageProblem(image);
  if (problem !== undefined) throw new Error(problem);
  if (argv.length === 0) throw new Error('a sandboxed run needs a command');
  if (!/^second-look-[0-9a-f]+$/.test(name)) throw new Error(`not a sandboxed run's container name: ${name}`);
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    SANDBOX_USER,
    '--pids-limit',
    String(limits.pids),
    '--memory',
    `${limits.memoryMiB}m`,
    '--memory-swap',
    `${limits.memoryMiB}m`,
    '--cpus',
    String(limits.cpus),
    ...tmpfs(SANDBOX_WORK_DIR, limits.workMiB),
    ...tmpfs('/tmp', limits.tmpMiB),
    ...tmpfs(SANDBOX_HOME, limits.homeMiB),
    '--pull',
    'never',
    image,
    'sh',
    '-c',
    UNPACK_AND_RUN,
    '--',
    ...argv,
  ];
}

const BLOCK = 512;

/** One ustar header block; a path longer than its name field goes in a PAX record before it. */
function tarHeader(path: string, type: '0' | '5' | 'x', size: number, mode: number, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  const field = (value: string, start: number, length: number): void => {
    header.write(value, start, length, 'utf8');
  };
  const octal = (value: number, start: number, length: number): void => {
    field(`${value.toString(8).padStart(length - 1, '0')}\0`, start, length);
  };
  field(path, 0, 100);
  octal(mode, 100, 8);
  octal(65534, 108, 8);
  octal(65534, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  header.fill(' ', 148, 156);
  field(type, 156, 1);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  field(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

/** The zero bytes that fill an entry's content up to a whole block. */
function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** One entry: a PAX record first when its path does not fit the header, then the header and its content. */
function tarEntry(path: string, type: '0' | '5', content: Buffer, mode: number, mtime: number): Buffer[] {
  const blocks: Buffer[] = [];
  if (Buffer.byteLength(path) > 100) {
    // A PAX record's length counts its own digits.
    const body = ` path=${path}\n`;
    let length = Buffer.byteLength(body);
    while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
    const record = Buffer.from(`${length}${body}`);
    blocks.push(tarHeader('././@PaxHeader', 'x', record.length, 0o644, mtime), record, padding(record.length));
  }
  blocks.push(tarHeader(path.slice(0, 100), type, content.length, mode, mtime), content, padding(content.length));
  return blocks;
}

/**
 * A tar archive of a copy, as a stream: its folders and regular files by
 * their paths under it, folders first, owned by the run's user, folders
 * and files writable by it so a build can write in `/work`. Anything else
 * — a link or a special file — is left out; the copy holds none.
 */
export function tarCopy(dir: string): Readable {
  async function* entries(folder: string, prefix: string): AsyncGenerator<Buffer> {
    const children = (await readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const path = join(folder, child.name);
      const relative = `${prefix}${child.name}`;
      if (child.isDirectory()) {
        const { mtimeMs } = await stat(path);
        yield* tarEntry(`${relative}/`, '5', Buffer.alloc(0), 0o755, Math.floor(mtimeMs / 1000));
        yield* entries(path, `${relative}/`);
      } else if (child.isFile()) {
        const { mtimeMs } = await stat(path);
        yield* tarEntry(relative, '0', await readFile(path), 0o644, Math.floor(mtimeMs / 1000));
      }
    }
  }
  async function* archive(): AsyncGenerator<Buffer> {
    yield* entries(dir, '');
    yield Buffer.alloc(BLOCK * 2);
  }
  return Readable.from(archive(), { objectMode: false });
}

/** What a sandboxed run returns: always labelled with the commit, the image and the command. */
export interface SandboxRun {
  runtime: SandboxRuntimeName;
  runtimeVersion: string;
  image: string;
  commit: string;
  /** The command that ran in the copy, one argument per word. */
  argv: string[];
  /** The command's exit code; null when the run did not end on its own. */
  exitCode: number | null;
  /** The last few KiB of what it printed, stdout and stderr together. */
  output: string;
  /** When the run started, as an ISO 8601 time. */
  startedAt: string;
  durationMs: number;
}

export interface SandboxRunRequest {
  runtime: SandboxRuntime;
  /** The image, pinned by digest. */
  image: string;
  /** The head copy the command runs in. */
  copy: { commit: string; path: string };
  argv: readonly string[];
  limits?: SandboxLimits;
}

/**
 * Runs a command in the head copy inside a locked-down container. The
 * pinned image is pulled first, as a step of its own; the copy then
 * streams in as a tar archive on stdin. The container is stopped by its
 * name — `docker kill` or `podman kill` — when the time limit passes or
 * the engine is told to stop. Refuses an image without a digest, and an
 * empty command, before anything runs.
 */
export async function runSandboxed(request: SandboxRunRequest, deps: Pick<SandboxDeps, 'env' | 'start'> = {}): Promise<SandboxRun> {
  const { runtime, image, copy } = request;
  const argv = [...request.argv];
  const limits = request.limits ?? DEFAULT_SANDBOX_LIMITS;
  const env = runtimeEnv(deps.env ?? process.env);
  const start = deps.start ?? startRuntime;
  const name = sandboxName();
  const args = sandboxArgv({ name, image, argv, limits });

  const pull = await runToEnd(start, runtime.path, ['pull', image], env, PULL_TIMEOUT_MS);
  if (pull.code !== 0) {
    throw new Error(`${runtime.name} could not pull the image ${image}, so nothing ran${pull.output ? `: ${pull.output.split('\n').at(-1)}` : ''}`);
  }

  const startedAt = new Date();
  let killing: Promise<void> | undefined;
  const kill = (): Promise<void> =>
    (killing ??= runToEnd(start, runtime.path, ['kill', name], env, KILL_TIMEOUT_MS).then(() => undefined));
  const child = trackAgentChild(start(runtime.path, args, env), kill);

  return new Promise<SandboxRun>((resolve, reject) => {
    let output = '';
    let stoppedBy: string | undefined;
    const keep = (chunk: string): void => {
      output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.setEncoding('utf8').on('data', keep);
    child.stderr?.setEncoding('utf8').on('data', keep);
    // The container may end before it reads the whole copy; that is its
    // exit code's story, not an error of the run.
    child.stdin?.on('error', () => undefined);
    const archive = tarCopy(copy.path);
    archive.once('error', (error) => {
      keep(`\nthe copy could not be sent: ${error.message}`);
      child.stdin?.end();
    });
    if (child.stdin) archive.pipe(child.stdin);

    const timer = setTimeout(() => {
      stoppedBy = `stopped after the time limit of ${Math.round(limits.timeoutMs / 1000)} s`;
      void kill();
    }, limits.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      archive.destroy();
      reject(new Error(`${runtime.name} could not be started: ${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      archive.destroy();
      if (stoppedBy === undefined && killing !== undefined) stoppedBy = 'stopped because the engine was told to stop';
      resolve({
        runtime: runtime.name,
        runtimeVersion: runtime.version,
        image,
        commit: copy.commit,
        argv,
        exitCode: stoppedBy === undefined ? code : null,
        output: stoppedBy === undefined ? output : `${output}\n(${stoppedBy})`.slice(-OUTPUT_TAIL_CHARS),
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
      });
    });
  });
}

/** One argument as a POSIX shell would need it written, for showing a command. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** What the reviewer is shown before a sandboxed run starts: the commit, the image, the command and the isolation. */
export function describeSandboxedRun(request: {
  pullRequestUrl: string;
  commit: string;
  image: string;
  argv: readonly string[];
  runtime: SandboxRuntime;
  limits?: SandboxLimits;
}): string {
  const limits = request.limits ?? DEFAULT_SANDBOX_LIMITS;
  return [
    "This runs the pull request's code in a container:",
    '',
    `  Pull request  ${request.pullRequestUrl}`,
    `  Commit        ${request.commit}`,
    `  Image         ${request.image}, pulled first by its digest`,
    `  Command       ${request.argv.map(shellWord).join(' ')}, in ${SANDBOX_WORK_DIR}`,
    `  Runtime       ${request.runtime.name} ${request.runtime.version}`,
    '',
    'Isolation:',
    '  - No network: only loopback exists.',
    `  - No host folder: the copy streams in on stdin and is unpacked into ${SANDBOX_WORK_DIR}, in memory.`,
    '  - No host environment variable is passed in.',
    '  - A read-only root; the only writable places are in memory and gone when the run ends:',
    `    ${SANDBOX_WORK_DIR} (${limits.workMiB} MiB), /tmp (${limits.tmpMiB} MiB) and the home folder ${SANDBOX_HOME} (${limits.homeMiB} MiB).`,
    `  - A non-root user (${SANDBOX_USER}), every Linux capability dropped, no new privileges.`,
    `  - At most ${limits.cpus} CPUs, ${limits.memoryMiB} MiB of memory with no swap, ${limits.pids} processes,`,
    `    and ${Math.round(limits.timeoutMs / 60_000)} minutes before the container is killed.`,
  ].join('\n');
}
