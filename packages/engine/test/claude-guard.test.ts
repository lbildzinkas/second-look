import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { answerPreToolUse, checkClaudeToolCall } from '../src/claude-guard-check.js';
import { CREDENTIAL_PATHS } from '../src/read-guard.js';
import { CLAUDE_GUARD } from './fake-claude.js';

// The home folder is a fake one in a temporary folder: no test touches a
// real credential path.
let base: string;
let root: string;
let home: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'second-look-claude-guard-'));
  root = join(base, 'copy');
  home = join(base, 'home');
  outside = join(base, 'outside.txt');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Copy\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'decoy\n');
  writeFileSync(outside, 'outside\n');
});

const check = (tool: string, input: Record<string, unknown>) => checkClaudeToolCall(tool, input, root, home);
const read = (path: string) => check('Read', { file_path: path });

describe('checkClaudeToolCall', () => {
  it('passes reads of the copy by relative or absolute path', () => {
    expect(read('src/app.ts')).toBeUndefined();
    expect(read(join(root, 'src', 'app.ts'))).toBeUndefined();
    expect(read(realpathSync(join(root, 'README.md')))).toBeUndefined();
  });

  it('lets Grep and Glob search the copy, defaulting to its root', () => {
    for (const tool of ['Grep', 'Glob']) {
      expect(check(tool, { pattern: 'app' })).toBeUndefined();
      expect(check(tool, { pattern: '**/*.ts', path: 'src' })).toBeUndefined();
      expect(check(tool, { pattern: 'app', path: root })).toBeUndefined();
    }
    expect(check('Grep', { pattern: 'app', glob: '*.{ts,tsx}' })).toBeUndefined();
  });

  it('refuses absolute paths outside the copy', () => {
    expect(read(outside)).toBe('only files of the read-only copy may be read');
    expect(read('/etc/hosts')).toBe('only files of the read-only copy may be read');
    expect(check('Grep', { pattern: 'x', path: base })).toBe('only files of the read-only copy may be read');
    expect(check('Glob', { pattern: '*.txt', path: base })).toBe('only files of the read-only copy may be read');
  });

  it('refuses climbing out with ..', () => {
    expect(read('../outside.txt')).toBe('only files of the read-only copy may be read');
    expect(read('src/../../outside.txt')).toBe('only files of the read-only copy may be read');
    expect(check('Grep', { pattern: 'x', path: '..' })).toBe('only files of the read-only copy may be read');
    expect(check('Glob', { pattern: '*', path: '../' })).toBe('only files of the read-only copy may be read');
  });

  it('resolves ~ to the home folder, never to the copy', () => {
    expect(read('~')).toBe('only files of the read-only copy may be read');
    expect(check('Glob', { pattern: '*', path: '~' })).toBe('only files of the read-only copy may be read');
    expect(read('~/.ssh/id_ed25519')).toBe('credential paths may not be read');
    expect(read('~/.ssh/second-look-probe-does-not-exist')).toBe('credential paths may not be read');
  });

  describe.each(CREDENTIAL_PATHS.map((credential) => [credential.path, credential] as const))(
    'the credential path %s',
    (_path, credential) => {
      const spellings = (folder: string) => [
        `~/${credential.path}`,
        join(folder, credential.path),
        ...(credential.folder ? [`~/${credential.path}/key`, join(folder, credential.path, 'key')] : []),
      ];

      it('is refused by every spelling, before the file system is read', () => {
        for (const path of spellings(home)) expect(read(path)).toBe('credential paths may not be read');
        expect(check('Grep', { pattern: 'x', path: `~/${credential.path}` })).toBe('credential paths may not be read');
        expect(check('Glob', { pattern: '*', path: `~/${credential.path}` })).toBe('credential paths may not be read');
      });

      it('is refused even when the copy is the home folder and the file does not exist', () => {
        for (const path of spellings(home)) {
          expect(checkClaudeToolCall('Read', { file_path: path }, home, home)).toBe('credential paths may not be read');
        }
      });
    },
  );

  it('refuses a symbolic link in the copy that leads outside it', () => {
    symlinkSync(outside, join(root, 'src', 'link.txt'));
    symlinkSync(base, join(root, 'link-out'));
    expect(read('src/link.txt')).toBe('the path leads outside the read-only copy');
    expect(read('link-out/outside.txt')).toBe('the path leads outside the read-only copy');
    expect(check('Grep', { pattern: 'x', path: 'link-out' })).toBe('the path leads outside the read-only copy');
    expect(check('Glob', { pattern: '*', path: 'link-out' })).toBe('the path leads outside the read-only copy');
  });

  it('accepts the copy named through an alias of its folder, as macOS names /tmp through /private/tmp', () => {
    const alias = join(mkdtempSync(join(tmpdir(), 'second-look-alias-')), 'alias');
    symlinkSync(base, alias);
    const aliasedRoot = join(alias, 'copy');
    const viaAlias = (path: string) => checkClaudeToolCall('Read', { file_path: path }, aliasedRoot, home);
    expect(viaAlias('src/app.ts')).toBeUndefined();
    expect(viaAlias(join(aliasedRoot, 'src', 'app.ts'))).toBeUndefined();
    expect(viaAlias(join(realpathSync(base), 'copy', 'src', 'app.ts'))).toBeUndefined();
    expect(viaAlias(join(alias, 'outside.txt'))).toBe('only files of the read-only copy may be read');
    expect(viaAlias(join(realpathSync(base), 'outside.txt'))).toBe('only files of the read-only copy may be read');
  });

  it.runIf(process.platform === 'darwin')('accepts a copy under /tmp read through /private/tmp on macOS', () => {
    const copy = mkdtempSync('/tmp/second-look-claude-guard-');
    writeFileSync(join(copy, 'a.ts'), 'export {};\n');
    const real = realpathSync(copy);
    expect(real.startsWith('/private/tmp/')).toBe(true);
    expect(checkClaudeToolCall('Read', { file_path: join(real, 'a.ts') }, copy, home)).toBeUndefined();
    expect(checkClaudeToolCall('Read', { file_path: '/private/tmp' }, copy, home)).toBe(
      'only files of the read-only copy may be read',
    );
  });

  it('refuses a path that does not exist in the copy', () => {
    expect(read('src/none.ts')).toBe('no such file in the read-only copy');
    expect(check('Glob', { pattern: '*', path: 'none' })).toBe('no such file in the read-only copy');
  });

  it.each(['/etc/*', '/etc/**/hosts', '~/.ssh/*', '~/*', 'C:\\Windows\\*', 'c:/Windows/*', '\\\\server\\share\\*', '{src,/etc}/*', '+(src|/etc)/*'])(
    'refuses the absolute Glob pattern %j',
    (pattern) => {
      expect(check('Glob', { pattern })).toBe('a pattern may not name an absolute path');
    },
  );

  it.each(['../outside/*.txt', '..', 'src/../../*', '**/../*', '{..,src}/outside/*', '..\\outside\\*', 'src\\..\\..\\*'])(
    'refuses the Glob pattern %j that climbs out',
    (pattern) => {
      expect(check('Glob', { pattern })).toBe('a pattern may not climb out with ..');
    },
  );

  it.each([
    ['../outside/*', 'a glob may not climb out with ..'],
    ['src/../../*', 'a glob may not climb out with ..'],
    ['/etc/*', 'a glob may not name an absolute path'],
    ['~/.ssh/*', 'a glob may not name an absolute path'],
    ['C:\\Users\\*', 'a glob may not name an absolute path'],
  ])('refuses the Grep glob %j', (glob, reason) => {
    expect(check('Grep', { pattern: 'x', glob })).toBe(reason);
  });

  it('keeps patterns that stay in the folder they search', () => {
    for (const pattern of ['**/*.ts', 'src/*.{ts,js}', '*.config.*', 'docs/**/README.md', '...']) {
      expect(check('Glob', { pattern })).toBeUndefined();
    }
  });

  it.each(['C:\\Users\\r\\.ssh\\id_ed25519', 'c:/Windows/win.ini', '\\\\server\\share\\file.txt', '..\\outside.txt', 'src\\..\\..\\outside.txt'])(
    'refuses the Windows-shaped path %j',
    (path) => {
      expect(read(path)).toEqual(expect.any(String));
      expect(check('Grep', { pattern: 'x', path })).toEqual(expect.any(String));
    },
  );

  it.each(['https://example.com/', 'file:///etc/passwd', 'http://169.254.169.254/latest/meta-data'])('refuses the URL %s', (url) => {
    expect(read(url)).toMatch(/^URLs are refused/);
  });

  it('passes the StructuredOutput answer, which touches no file', () => {
    expect(check('StructuredOutput', { verdict: 'yes' })).toBeUndefined();
    expect(checkClaudeToolCall('StructuredOutput', {}, undefined, home)).toBeUndefined();
  });

  it.each(['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'mcp__server__read_file', 'read'])(
    'denies the %s tool',
    (tool) => {
      expect(check(tool, { file_path: 'src/app.ts', command: 'cat /etc/hosts' })).toBe(
        `the ${tool} tool is not allowed: only Read, Grep, Glob may run`,
      );
    },
  );

  it('denies every read when no read root is set', () => {
    expect(checkClaudeToolCall('Read', { file_path: 'src/app.ts' }, undefined, home)).toMatch(/SECOND_LOOK_READ_ROOT is not set/);
    expect(checkClaudeToolCall('Glob', { pattern: '*' }, '', home)).toMatch(/SECOND_LOOK_READ_ROOT is not set/);
  });

  it('denies a Read with no file, and any path or pattern that is not a string', () => {
    expect(check('Read', {})).toBe('the Read tool must name a file to read');
    expect(check('Read', { file_path: 7 })).toBe('the path is not a string');
    expect(check('Grep', { pattern: 'x', path: ['src'] })).toBe('the path is not a string');
    expect(check('Glob', { pattern: ['*'] })).toBe('the pattern is not a string');
    expect(check('Grep', { pattern: 'x', glob: 1 })).toBe('the glob is not a string');
  });
});

describe('answerPreToolUse', () => {
  const event = (tool: string, input: Record<string, unknown>, id = 'toolu_1') =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id });
  const env = (audit?: string): NodeJS.ProcessEnv => ({
    SECOND_LOOK_READ_ROOT: root,
    ...(audit ? { SECOND_LOOK_GUARD_AUDIT: audit } : {}),
  });

  it('denies a refused call with the reason, through the permission decision', () => {
    const answer = answerPreToolUse(event('Read', { file_path: '/etc/hosts' }), env(), home);
    expect(answer).toEqual({ exitCode: 0, stdout: expect.any(String), stderr: '' });
    expect(JSON.parse(answer.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Refused by Second Look: only files of the read-only copy may be read',
      },
    });
  });

  it('passes an allowed call with no answer, never allow and never a rewritten input', () => {
    expect(answerPreToolUse(event('Read', { file_path: 'src/app.ts' }), env(), home)).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('writes one audit line per call, passed or denied', () => {
    const audit = join(base, 'audit.jsonl');
    answerPreToolUse(event('Read', { file_path: 'src/app.ts' }, 'toolu_a'), env(audit), home);
    answerPreToolUse(event('Read', { file_path: '/etc/hosts' }, 'toolu_b'), env(audit), home);
    answerPreToolUse(event('StructuredOutput', { verdict: 'yes' }, 'toolu_c'), env(audit), home);
    expect(readFileSync(audit, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 'toolu_a', tool: 'Read', decision: 'pass' },
      { id: 'toolu_b', tool: 'Read', decision: 'deny' },
      { id: 'toolu_c', tool: 'StructuredOutput', decision: 'pass' },
    ]);
  });

  it('denies a call it cannot write the audit line for', () => {
    const answer = answerPreToolUse(event('Read', { file_path: 'src/app.ts' }), env(join(base, 'no-such-folder', 'audit.jsonl')), home);
    expect(JSON.parse(answer.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Refused by Second Look: the guard could not write its audit line' },
    });
  });

  it('denies a call that names no tool-use id to audit', () => {
    const answer = answerPreToolUse(event('Read', { file_path: 'src/app.ts' }, ''), env(), home);
    expect(JSON.parse(answer.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it.each(['', 'not json', '[]', 'null', '{"tool_input":{}}', '{"tool_name":7}'])(
    'blocks with exit code 2 on the unreadable event %j',
    (text) => {
      const answer = answerPreToolUse(text, env(), home);
      expect(answer.exitCode).toBe(2);
      expect(answer.stdout).toBe('');
      expect(answer.stderr).toMatch(/^Refused by Second Look: /);
    },
  );
});

describe('the guard hook process', () => {
  const runHook = (input: string, extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [CLAUDE_GUARD], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], HOME: home, SECOND_LOOK_READ_ROOT: root, ...extraEnv },
    });

  it('answers a refused call on stdout and exits 0', () => {
    const hook = runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, tool_use_id: 't' }));
    expect(hook.status).toBe(0);
    expect(JSON.parse(hook.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('passes an allowed call with no output, and audits it', () => {
    const audit = join(base, 'audit.jsonl');
    const hook = runHook(
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'src/app.ts' }, tool_use_id: 't' }),
      { SECOND_LOOK_GUARD_AUDIT: audit },
    );
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe('');
    expect(JSON.parse(readFileSync(audit, 'utf8'))).toEqual({ id: 't', tool: 'Read', decision: 'pass' });
  });

  it('refuses credential paths by the fake home folder it is given', () => {
    const hook = runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '~/.ssh/id_ed25519' }, tool_use_id: 't' }));
    expect(JSON.parse(hook.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: 'Refused by Second Look: credential paths may not be read' },
    });
  });

  it('exits 2, which blocks the call, on malformed input', () => {
    const hook = runHook('{"tool_name":');
    expect(hook.status).toBe(2);
    expect(hook.stdout).toBe('');
    expect(hook.stderr).toMatch(/^Refused by Second Look: the guard failed/);
  });
});
