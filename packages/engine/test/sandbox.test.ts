import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stopAgentChildren } from '../src/agent-children.js';
import { removeCopy } from '../src/cache.js';
import {
  DEFAULT_SANDBOX_LIMITS,
  describeSandboxedRun,
  imageProblem,
  probeSandbox,
  runSandboxed,
  runtimeEnv,
  sandboxArgv,
  sandboxName,
  tarCopy,
  type SandboxRuntime,
} from '../src/sandbox.js';
import { answering, fakeRuntime, type FakeCall, type FakeChild } from './fake-runtime.js';

const IMAGE = `node@sha256:${'ab'.repeat(32)}`;
const RUNTIME: SandboxRuntime = { name: 'docker', path: '/usr/local/bin/docker', version: '29.1.3' };
const COMMIT = 'c'.repeat(40);

/** The entries of a tar archive: each path, with a PAX record's path first, and its type and content. */
function tarEntries(bytes: Buffer): { path: string; type: string; mode: number; content: string }[] {
  const entries: { path: string; type: string; mode: number; content: string }[] = [];
  let pending: string | undefined;
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number): string => header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
    const size = parseInt(text(124, 12), 8);
    const type = text(156, 1);
    const content = bytes.subarray(offset + 512, offset + 512 + size).toString('utf8');
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pending = /path=(.*)\n/.exec(content)![1];
      continue;
    }
    entries.push({ path: pending ?? text(0, 100), type, mode: parseInt(text(100, 8), 8), content });
    pending = undefined;
  }
  return entries;
}

const folders: string[] = [];

/** A copy laid out as the cache leaves one: read-only files and folders. */
function readOnlyCopy(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'second-look-sandbox-test-'));
  folders.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content, { mode: 0o444 });
  }
  chmodSync(dir, 0o555);
  return dir;
}

/** A folder holding a runnable file for each named program, which no test runs. */
function programsDir(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'second-look-programs-'));
  folders.push(dir);
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  return dir;
}

afterEach(async () => {
  for (const dir of folders.splice(0)) await removeCopy(dir);
});

describe('sandboxArgv', () => {
  const name = sandboxName();
  const argv = sandboxArgv({ name, image: IMAGE, argv: ['npm', 'test', '--', '--grep', 'a b'] });

  it('mounts no host path and passes no environment, privilege or socket', () => {
    for (const flag of ['-v', '--volume', '--mount', '-e', '--env', '--env-file', '--env-host', '--privileged', '--device', '--ipc', '--pid', '--userns']) {
      expect(argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
    }
    expect(argv.join(' ')).not.toMatch(/docker\.sock|podman\.sock|\/var\/run|\/run\/user/);
    for (const flag of ['--tmpfs']) {
      const targets = argv.flatMap((arg, index) => (argv[index - 1] === flag ? [arg.split(':')[0]] : []));
      expect(targets).toEqual(['/work', '/tmp', '/home/second-look']);
    }
  });

  it('cuts the network, locks the root, drops every capability and runs as a non-root user', () => {
    const pair = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
    expect(argv.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    expect(pair('--name')).toBe(name);
    expect(name).toMatch(/^second-look-[0-9a-f]{12}$/);
    expect(pair('--network')).toBe('none');
    expect(argv).toContain('--read-only');
    expect(pair('--cap-drop')).toBe('ALL');
    expect(pair('--security-opt')).toBe('no-new-privileges');
    expect(pair('--user')).toBe('65534:65534');
    expect(pair('--user')!.split(':').every((id) => Number(id) !== 0)).toBe(true);
    expect(pair('--pull')).toBe('never');
    expect(pair('--memory')).toBe(pair('--memory-swap'));
    expect(pair('--pids-limit')).toBe(String(DEFAULT_SANDBOX_LIMITS.pids));
    expect(pair('--cpus')).toBe(String(DEFAULT_SANDBOX_LIMITS.cpus));
  });

  it('makes every tmpfs writable, runnable and in memory only', () => {
    const mounts = argv.filter((_, index) => argv[index - 1] === '--tmpfs');
    for (const mount of mounts) expect(mount).toMatch(/^\/[a-z/-]+:rw,exec,nosuid,nodev,size=\d+m,mode=1777$/);
  });

  it('runs the image pinned by digest, then the command one argument per word after the script', () => {
    const at = argv.indexOf(IMAGE);
    expect(at).toBeGreaterThan(0);
    expect(argv[at]).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(argv.slice(at + 1, at + 3)).toEqual(['sh', '-c']);
    expect(argv[at + 3]).toBe('export HOME=/home/second-look && tar -x -f - -C /work && cd /work && exec "$@"');
    expect(argv.slice(at + 4)).toEqual(['--', 'npm', 'test', '--', '--grep', 'a b']);
    // Every flag comes before the image, so nothing in the command is read as one.
    expect(argv.slice(0, at).every((arg) => !arg.includes('npm'))).toBe(true);
  });

  it('refuses an image without a digest, and an empty command', () => {
    for (const image of ['node:22', 'node', 'node@sha256:abc', `--privileged@sha256:${'a'.repeat(64)}`, `node@sha512:${'a'.repeat(64)}`]) {
      expect(imageProblem(image)).toMatch(/pinned by its digest/);
      expect(() => sandboxArgv({ name, image, argv: ['true'] })).toThrow(/pinned by its digest/);
    }
    expect(() => sandboxArgv({ name, image: IMAGE, argv: [] })).toThrow(/needs a command/);
    expect(imageProblem(`ghcr.io/owner/image:1.2@sha256:${'0'.repeat(64)}`)).toBeUndefined();
  });
});

describe('runtimeEnv', () => {
  it('keeps the path and the runtime connection variables only', () => {
    expect(
      runtimeEnv({ PATH: '/bin', HOME: '/home/me', DOCKER_HOST: 'unix:///x.sock', GITHUB_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', NODE_OPTIONS: '--x' }),
    ).toEqual({ PATH: '/bin', HOME: '/home/me', DOCKER_HOST: 'unix:///x.sock' });
  });
});

describe('probeSandbox', () => {
  it('reports a missing runtime in plain words, with how to install one, and starts nothing', async () => {
    const runtime = fakeRuntime(() => undefined);
    const probe = await probeSandbox({ dirs: [programsDir()], start: runtime.start, env: {} });
    expect(probe).toEqual({ usable: false, reason: expect.stringMatching(/^Neither docker nor podman is on the PATH.*Install Docker.*Podman/) });
    expect(runtime.calls).toEqual([]);
  });

  it('reports a daemon that does not answer, with how to start it', async () => {
    const runtime = fakeRuntime((call) =>
      call.child.finish(1, '{"Client":{"Version":"29.1.3"},"Server":null}\nCannot connect to the Docker daemon at unix:///var/run/docker.sock.'),
    );
    const probe = await probeSandbox({ dirs: [programsDir('docker')], start: runtime.start, env: {} });
    expect(probe).toEqual({ usable: false, reason: expect.stringMatching(/^docker is installed but no daemon answers.*Start Docker Desktop/) });
    expect(runtime.calls.map((call) => call.args)).toEqual([['version', '--format', '{{json .}}']]);
  });

  it('finds docker before podman and learns the server version', async () => {
    const dir = programsDir('docker', 'podman');
    const runtime = fakeRuntime((call) => call.child.finish(0, '{"Client":{"Version":"29.1.3"},"Server":{"Version":"28.0.1"}}'));
    const probe = await probeSandbox({ dirs: [dir], start: runtime.start, env: { PATH: dir, GITHUB_TOKEN: 'secret' } });
    expect(probe).toEqual({ usable: true, runtime: { name: 'docker', path: join(dir, 'docker'), version: '28.0.1' } });
    expect(runtime.calls[0]!.env).toEqual({ PATH: dir });
  });

  it('takes podman when there is no docker, and asks its machine to answer', async () => {
    const dir = programsDir('podman');
    const silent = fakeRuntime((call) => call.child.finish(125, 'Cannot connect to Podman. Please verify your connection'));
    expect(await probeSandbox({ dirs: [dir], start: silent.start, env: {} })).toEqual({
      usable: false,
      reason: expect.stringMatching(/^podman is installed but no machine or service answers.*podman machine start/),
    });
    const local = fakeRuntime((call) => call.child.finish(0, '{"Client":{"Version":"5.4.0"}}'));
    expect(await probeSandbox({ dirs: [dir], start: local.start, env: {} })).toEqual({
      usable: true,
      runtime: { name: 'podman', path: join(dir, 'podman'), version: '5.4.0' },
    });
  });
});

describe('tarCopy', () => {
  it('archives the copy’s folders and files, writable by the run’s user, with long paths in PAX records', async () => {
    const deep = `${'folder-'.repeat(20)}/file.txt`;
    const dir = readOnlyCopy({ 'a.txt': 'alpha\n', 'src/b.ts': 'beta\n', [deep]: 'deep\n' });
    const chunks: Buffer[] = [];
    for await (const chunk of tarCopy(dir)) chunks.push(chunk as Buffer);
    const entries = tarEntries(Buffer.concat(chunks));
    expect(entries.map(({ path, type }) => [path, type])).toEqual([
      ['a.txt', '0'],
      [`${'folder-'.repeat(20)}/`, '5'],
      [deep, '0'],
      ['src/', '5'],
      ['src/b.ts', '0'],
    ]);
    expect(entries.find((entry) => entry.path === deep)!.content).toBe('deep\n');
    expect(entries.find((entry) => entry.path === 'src/')!.mode).toBe(0o755);
    expect(entries.find((entry) => entry.path === 'a.txt')!.mode).toBe(0o644);
  });
});

describe('runSandboxed', () => {
  const copyFiles = { 'package.json': '{}\n', 'src/index.ts': 'export {};\n' };

  it('pulls the pinned image first, then streams the copy into the locked-down run and labels the result', async () => {
    const copy = readOnlyCopy(copyFiles);
    const runtime = fakeRuntime(answering('ok\n'));
    const run = await runSandboxed(
      { runtime: RUNTIME, image: IMAGE, copy: { commit: COMMIT, path: copy }, argv: ['npm', 'test'] },
      { start: runtime.start, env: { PATH: '/bin', GITHUB_TOKEN: 'secret', SECRET: 'x' } },
    );

    expect(runtime.calls.map((call) => call.args[0])).toEqual(['pull', 'run']);
    expect(runtime.calls[0]!.args).toEqual(['pull', IMAGE]);
    expect(runtime.calls.every((call) => call.program === RUNTIME.path)).toBe(true);
    expect(runtime.calls.every((call) => JSON.stringify(call.env) === '{"PATH":"/bin"}')).toBe(true);
    const runArgs = runtime.calls[1]!.args;
    expect(runArgs).toEqual(sandboxArgv({ name: runArgs[runArgs.indexOf('--name') + 1]!, image: IMAGE, argv: ['npm', 'test'] }));
    expect(tarEntries(Buffer.concat(runtime.calls[1]!.stdin)).map((entry) => entry.path)).toEqual(['package.json', 'src/', 'src/index.ts']);
    expect(run).toEqual({
      runtime: 'docker',
      runtimeVersion: '29.1.3',
      image: IMAGE,
      commit: COMMIT,
      argv: ['npm', 'test'],
      exitCode: 0,
      output: 'ok\n',
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      durationMs: expect.any(Number),
    });
  });

  it('keeps only the last few KiB of the output and the command’s exit code', async () => {
    const copy = readOnlyCopy(copyFiles);
    const runtime = fakeRuntime(answering(`${'x'.repeat(50_000)}the end\n`, 3));
    const run = await runSandboxed(
      { runtime: RUNTIME, image: IMAGE, copy: { commit: COMMIT, path: copy }, argv: ['false'] },
      { start: runtime.start, env: {} },
    );
    expect(run.exitCode).toBe(3);
    expect(run.output.length).toBe(8 * 1024);
    expect(run.output.endsWith('the end\n')).toBe(true);
  });

  it('refuses an image without a digest, and an empty command, before anything runs', async () => {
    const copy = readOnlyCopy(copyFiles);
    const runtime = fakeRuntime(answering(''));
    await expect(
      runSandboxed({ runtime: RUNTIME, image: 'node:22', copy: { commit: COMMIT, path: copy }, argv: ['true'] }, { start: runtime.start }),
    ).rejects.toThrow(/pinned by its digest/);
    await expect(
      runSandboxed({ runtime: RUNTIME, image: IMAGE, copy: { commit: COMMIT, path: copy }, argv: [] }, { start: runtime.start }),
    ).rejects.toThrow(/needs a command/);
    expect(runtime.calls).toEqual([]);
  });

  it('runs nothing when the image cannot be pulled', async () => {
    const copy = readOnlyCopy(copyFiles);
    const runtime = fakeRuntime((call) => call.child.finish(1, 'Error response from daemon: manifest unknown'));
    await expect(
      runSandboxed({ runtime: RUNTIME, image: IMAGE, copy: { commit: COMMIT, path: copy }, argv: ['true'] }, { start: runtime.start, env: {} }),
    ).rejects.toThrow(/could not pull the image .*so nothing ran: Error response from daemon: manifest unknown/);
    expect(runtime.calls.map((call) => call.args[0])).toEqual(['pull']);
  });

  /** A runtime whose container runs until it is killed by name. */
  function untilKilled(): ReturnType<typeof fakeRuntime> {
    const containers = new Map<string, FakeChild>();
    return fakeRuntime((call) => {
      if (call.args[0] === 'run') {
        containers.set(call.args[call.args.indexOf('--name') + 1]!, call.child);
        return;
      }
      if (call.args[0] === 'kill') containers.get(call.args[1]!)?.finish(137, 'killed\n');
      call.child.finish(0);
    });
  }

  it('kills the container by its name when the time limit passes', async () => {
    const copy = readOnlyCopy(copyFiles);
    const runtime = untilKilled();
    const run = await runSandboxed(
      {
        runtime: RUNTIME,
        image: IMAGE,
        copy: { commit: COMMIT, path: copy },
        argv: ['sleep', '600'],
        limits: { ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 50 },
      },
      { start: runtime.start, env: {} },
    );

    const name = runtime.calls[1]!.args[runtime.calls[1]!.args.indexOf('--name') + 1];
    expect(runtime.calls.map((call) => call.args)).toEqual([['pull', IMAGE], expect.arrayContaining(['run']), ['kill', name]]);
    expect(runtime.calls[1]!.child.killed).toEqual([]);
    expect(run.exitCode).toBeNull();
    expect(run.output).toBe('killed\n\n(stopped after the time limit of 0 s)');
  });

  it('kills a running container by its name when the engine is told to stop', async () => {
    const copy = readOnlyCopy(copyFiles);
    const runtime = untilKilled();
    const running = runSandboxed(
      { runtime: RUNTIME, image: IMAGE, copy: { commit: COMMIT, path: copy }, argv: ['sleep', '600'] },
      { start: runtime.start, env: {} },
    );
    while (runtime.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));

    await stopAgentChildren(1000);
    const run = await running;

    const name = runtime.calls[1]!.args[runtime.calls[1]!.args.indexOf('--name') + 1];
    expect(runtime.calls.at(-1)!.args).toEqual(['kill', name]);
    expect(runtime.calls[1]!.child.killed).toEqual([]);
    expect(run.exitCode).toBeNull();
    expect(run.output).toContain('(stopped because the engine was told to stop)');
  });

  /** A runtime whose container is created only after a first kill has missed it. */
  function createdLate(): ReturnType<typeof fakeRuntime> {
    let run: FakeCall | undefined;
    let kills = 0;
    return fakeRuntime((call) => {
      if (call.args[0] === 'run') {
        run = call;
        return;
      }
      if (call.args[0] === 'kill') {
        kills += 1;
        if (kills > 1) {
          run!.child.finish(137, 'killed\n');
          call.child.finish(0);
          return;
        }
        call.child.finish(1, `Error response from daemon: No such container: ${call.args[1]}`);
        return;
      }
      call.child.finish(0);
    });
  }

  it('kills a container still being created, once it exists, when the engine is told to stop', async () => {
    const copy = readOnlyCopy(copyFiles);
    const runtime = createdLate();
    const running = runSandboxed(
      { runtime: RUNTIME, image: IMAGE, copy: { commit: COMMIT, path: copy }, argv: ['sleep', '600'] },
      { start: runtime.start, env: {} },
    );
    while (runtime.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));

    await stopAgentChildren(1000);
    const run = await running;

    const name = runtime.calls[1]!.args[runtime.calls[1]!.args.indexOf('--name') + 1];
    expect(runtime.calls.filter((call) => call.args[0] === 'kill').map((call) => call.args)).toEqual([
      ['kill', name],
      ['kill', name],
    ]);
    expect(runtime.calls[1]!.child.killed).toEqual([]);
    expect(run.exitCode).toBeNull();
    expect(run.output).toContain('(stopped because the engine was told to stop)');
  });

  /** A runtime whose container has already exited and been removed when the kill arrives. */
  function exitedBeforeKill(): ReturnType<typeof fakeRuntime> {
    let run: FakeCall | undefined;
    let kills = 0;
    return fakeRuntime((call) => {
      if (call.args[0] === 'run') {
        run = call;
        return;
      }
      if (call.args[0] === 'kill') {
        kills += 1;
        call.child.finish(1, `Error response from daemon: No such container: ${call.args[1]}`);
        if (kills === 1) run!.child.finish(0, 'done\n');
        return;
      }
      call.child.finish(0);
    });
  }

  it('reports the run’s real exit code when the container already ended before the kill', async () => {
    const copy = readOnlyCopy(copyFiles);
    const runtime = exitedBeforeKill();
    const run = await runSandboxed(
      {
        runtime: RUNTIME,
        image: IMAGE,
        copy: { commit: COMMIT, path: copy },
        argv: ['sleep', '600'],
        limits: { ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 50 },
      },
      { start: runtime.start, env: {} },
    );

    expect(runtime.calls.some((call) => call.args[0] === 'kill')).toBe(true);
    expect(runtime.calls[1]!.child.killed).toEqual([]);
    expect(run.exitCode).toBe(0);
    expect(run.output).toBe('done\n');
  });
});

describe('describeSandboxedRun', () => {
  it('names the commit, the image, the command and the isolation', () => {
    const text = describeSandboxedRun({
      pullRequestUrl: 'https://github.com/example-org/example-repo/pull/42',
      commit: COMMIT,
      image: IMAGE,
      argv: ['sh', '-c', "echo 'hi' && ls"],
      runtime: RUNTIME,
    });
    expect(text).toContain(`Commit        ${COMMIT}`);
    expect(text).toContain(`Image         ${IMAGE}`);
    expect(text).toContain(`Command       sh -c 'echo '\\''hi'\\'' && ls', in /work`);
    expect(text).toContain('Runtime       docker 29.1.3');
    expect(text).toContain('No network');
    expect(text).toContain('No host folder');
    expect(text).toContain('No host environment variable');
    expect(text).toContain('non-root user (65534:65534)');
  });
});
