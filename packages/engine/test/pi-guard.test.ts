import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import secondLookGuard, { checkToolCall } from '../src/pi-guard.js';

// The home folder is a fake one in a temporary folder: no test touches a
// real credential path.
let root: string;
let home: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'second-look-guard-'));
  root = join(base, 'copy');
  home = join(base, 'home');
  outside = join(base, 'outside.txt');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'decoy\n');
  writeFileSync(outside, 'outside\n');
});

const read = (path: string) => checkToolCall('read', { path }, root, home);

describe('checkToolCall', () => {
  it('allows a file of the copy and hands the tool its real path', () => {
    expect(read('src/app.ts')).toEqual({ allowed: true, path: realpathSync(join(root, 'src', 'app.ts')) });
    expect(read(join(root, 'src', 'app.ts'))).toMatchObject({ allowed: true });
    expect(read('@src/app.ts')).toMatchObject({ allowed: true });
  });

  it('lets grep, find and ls search the copy, defaulting to its root', () => {
    for (const tool of ['grep', 'find', 'ls']) {
      expect(checkToolCall(tool, { pattern: 'app' }, root, home)).toEqual({ allowed: true, path: realpathSync(root) });
      expect(checkToolCall(tool, { pattern: 'app', path: 'src' }, root, home)).toMatchObject({ allowed: true });
    }
  });

  it.each([
    ['an SSH key', '~/.ssh/id_ed25519'],
    ['the SSH folder', '~/.ssh'],
    ['cloud credentials', '~/.aws/credentials'],
    ['Google Cloud credentials', '~/.config/gcloud/application_default_credentials.json'],
    ['the GitHub login', '~/.config/gh/hosts.yml'],
    ['git credentials', '~/.git-credentials'],
    ["Pi's own login", '~/.pi/agent/auth.json'],
  ])('refuses %s as a credential path', (_name, path) => {
    expect(read(path)).toEqual({ allowed: false, reason: 'credential paths may not be read' });
    expect(read(path.replace('~', home))).toEqual({ allowed: false, reason: 'credential paths may not be read' });
  });

  it.each(['https://example.com/', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', '  ftp://host/x'])(
    'refuses the URL %s',
    (url) => {
      const verdict = read(url);
      expect(verdict.allowed).toBe(false);
      expect(!verdict.allowed && verdict.reason).toMatch(/^URLs are refused/);
    },
  );

  it('refuses paths outside the copy, by absolute path or by climbing out', () => {
    expect(read(outside)).toEqual({ allowed: false, reason: 'only files of the read-only copy may be read' });
    expect(read('../outside.txt')).toEqual({ allowed: false, reason: 'only files of the read-only copy may be read' });
    expect(read('/etc/hosts')).toMatchObject({ allowed: false });
    expect(checkToolCall('grep', { pattern: 'x', path: '..' }, root, home)).toMatchObject({ allowed: false });
  });

  it('refuses a symbolic link in the copy that leads outside it', () => {
    symlinkSync(outside, join(root, 'src', 'link.txt'));
    expect(read('src/link.txt')).toEqual({ allowed: false, reason: 'the path leads outside the read-only copy' });
  });

  it('refuses a missing file instead of letting the tool guess a near name', () => {
    expect(read('src/none.ts')).toEqual({ allowed: false, reason: 'no such file in the read-only copy' });
  });

  it.each(['bash', 'edit', 'write', 'powershell', 'web_fetch'])('refuses the %s tool', (tool) => {
    const verdict = checkToolCall(tool, { path: 'src/app.ts', command: 'curl https://example.com' }, root, home);
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.reason).toMatch(/not allowed: only read, grep, find, ls may run/);
  });

  it('refuses everything when no read root is set', () => {
    expect(checkToolCall('read', { path: 'src/app.ts' }, undefined, home)).toMatchObject({ allowed: false });
    expect(checkToolCall('read', { path: 'src/app.ts' }, '', home)).toMatchObject({ allowed: false });
  });
});

describe('the guard extension', () => {
  const previous = process.env['SECOND_LOOK_READ_ROOT'];

  afterEach(() => {
    if (previous === undefined) delete process.env['SECOND_LOOK_READ_ROOT'];
    else process.env['SECOND_LOOK_READ_ROOT'] = previous;
  });

  function loadGuard() {
    let handler: ((event: { toolName: string; input: Record<string, unknown> }) => unknown) | undefined;
    secondLookGuard({ on: (_event, registered) => (handler = registered) });
    return handler!;
  }

  it('blocks a refused call with the reason, before the tool runs', () => {
    process.env['SECOND_LOOK_READ_ROOT'] = root;
    const handler = loadGuard();
    expect(handler({ toolName: 'read', input: { path: '/etc/hosts' } })).toEqual({
      block: true,
      reason: 'Refused by Second Look: only files of the read-only copy may be read',
    });
    expect(handler({ toolName: 'bash', input: { command: 'cat ~/.ssh/id_ed25519' } })).toMatchObject({ block: true });
  });

  it('rewrites an allowed call to the checked real path', () => {
    process.env['SECOND_LOOK_READ_ROOT'] = root;
    const handler = loadGuard();
    const event = { toolName: 'read', input: { path: 'src/app.ts' } as Record<string, unknown> };
    expect(handler(event)).toBeUndefined();
    expect(event.input['path']).toBe(realpathSync(join(root, 'src', 'app.ts')));
  });

  it('blocks every call when the read root is missing', () => {
    delete process.env['SECOND_LOOK_READ_ROOT'];
    const handler = loadGuard();
    expect(handler({ toolName: 'read', input: { path: 'src/app.ts' } })).toMatchObject({ block: true });
  });
});
