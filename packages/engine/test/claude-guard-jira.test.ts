import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { claudeEnvironment, claudeRunEnvironment } from '../src/claude-code.js';
import { answerPreToolUse, checkJiraToolCall, JIRA_GUARD_VARIABLE, readJiraGuardLimits, type JiraGuardLimits } from '../src/claude-guard-check.js';
import { JIRA_CONNECTOR_SERVER, JIRA_FALLBACK_SERVER, jiraGuardLimits, jiraRunEnvironment } from '../src/jira-connect.js';
import { CLAUDE_GUARD } from './fake-claude.js';

// The guard's Jira mode, tested on parsed hook events: the security heart
// of the Jira fetch run (ADR 0010, issue 192). Every name is spelled out
// in full here rather than built from the source's helpers, so a renamed
// tool in the source can't pass these tests by renaming them too.

const SITE = { id: '11111111-2222-3333-4444-555555555555', url: 'https://your-team.atlassian.net' };
const OTHER_SITE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FETCH: JiraGuardLimits = { site: SITE, answer: true };
const TEST_RUN: JiraGuardLimits = { site: SITE, answer: false };
const PROBE: JiraGuardLimits = { answer: false };

const ROUTES = [
  ['the connector', 'claude_ai_Atlassian_MCP'],
  ['the fallback', 'atlassian'],
] as const;

const check = (tool: string, input: Record<string, unknown>, limits: JiraGuardLimits = FETCH, root?: string) => checkJiraToolCall(tool, input, limits, root);

describe('checkJiraToolCall', () => {
  it('names the same two servers jira-connect.ts exports', () => {
    expect([JIRA_CONNECTOR_SERVER, JIRA_FALLBACK_SERVER]).toEqual(ROUTES.map(([, server]) => server));
  });

  describe.each(ROUTES)('on %s route', (_route, server) => {
    const issue = `mcp__${server}__getJiraIssue`;
    const resources = `mcp__${server}__getAccessibleAtlassianResources`;

    it('passes getJiraIssue on the chosen site with a key-shaped key, by the site’s id, address or host', () => {
      expect(check(issue, { cloudId: SITE.id, issueIdOrKey: 'PORT-42' })).toBeUndefined();
      expect(check(issue, { cloudId: 'https://your-team.atlassian.net/', issueIdOrKey: 'AB_1-7' })).toBeUndefined();
      expect(check(issue, { cloudId: 'your-team.atlassian.net', issueIdOrKey: 'PORT-42' }, TEST_RUN)).toBeUndefined();
    });

    it('passes getAccessibleAtlassianResources with no arguments, before a site is chosen too', () => {
      expect(check(resources, {})).toBeUndefined();
      expect(check(resources, {}, PROBE)).toBeUndefined();
    });

    it('denies getJiraIssue on another site, or with no cloudId', () => {
      expect(check(issue, { cloudId: OTHER_SITE_ID, issueIdOrKey: 'PORT-42' })).toBe('the cloudId must be the chosen Jira site');
      expect(check(issue, { cloudId: 'https://other-team.atlassian.net', issueIdOrKey: 'PORT-42' })).toBe('the cloudId must be the chosen Jira site');
      expect(check(issue, { cloudId: 'your-team.atlassian.net.evil.example', issueIdOrKey: 'PORT-42' })).toBe('the cloudId must be the chosen Jira site');
      expect(check(issue, { cloudId: '', issueIdOrKey: 'PORT-42' })).toBe('the cloudId must be the chosen Jira site');
      expect(check(issue, { issueIdOrKey: 'PORT-42' })).toBe('the cloudId must be the chosen Jira site');
      expect(check(issue, { cloudId: [SITE.id], issueIdOrKey: 'PORT-42' })).toBe('the cloudId must be the chosen Jira site');
    });

    it('denies getJiraIssue with a key that isn’t key-shaped', () => {
      for (const key of ['port-42', 'PORT-042', 'PORT', '10042', 'PORT-42 OR project = SECRET', 'PORT-42/comment', 'P-1', 42]) {
        expect(check(issue, { cloudId: SITE.id, issueIdOrKey: key })).toBe('the issueIdOrKey must be a Jira ticket key such as ABC-123');
      }
      expect(check(issue, { cloudId: SITE.id })).toBe('the issueIdOrKey must be a Jira ticket key such as ABC-123');
    });

    it('denies getJiraIssue given any argument but the site and the key', () => {
      expect(check(issue, { cloudId: SITE.id, issueIdOrKey: 'PORT-42', updateHistory: true })).toBe('getJiraIssue may be given only cloudId and issueIdOrKey, not updateHistory');
      expect(check(issue, { cloudId: SITE.id, issueIdOrKey: 'PORT-42', expand: 'changelog', fields: ['*all'] })).toBe(
        'getJiraIssue may be given only cloudId and issueIdOrKey, not expand, fields',
      );
    });

    it('denies getAccessibleAtlassianResources given arguments', () => {
      expect(check(resources, { cloudId: SITE.id })).toBe(`the ${resources} tool takes no arguments`);
    });

    it('denies every getJiraIssue in a probe, which has no site chosen', () => {
      expect(check(issue, { cloudId: SITE.id, issueIdOrKey: 'PORT-42' }, PROBE)).toBe('no Jira site is chosen, so no ticket may be fetched');
    });

    it.each([
      'createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addCommentToJiraIssue', 'addWorklogToJiraIssue',
      'executeRead', 'executeWrite', 'searchJiraIssuesUsingJql', 'getConfluencePage', 'createConfluencePage', 'atlassianUserInfo',
      'getJiraIssueRemoteIssueLinks', 'getjiraissue',
    ])('denies the server’s %s tool', (name) => {
      const tool = `mcp__${server}__${name}`;
      expect(check(tool, { cloudId: SITE.id, issueIdOrKey: 'PORT-42' })).toBe(
        `the ${tool} tool is not allowed: a Jira run may call only getJiraIssue and getAccessibleAtlassianResources`,
      );
    });
  });

  it.each([
    'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite',
    'mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Google_Drive__read_file_content',
    'mcp__plugin_atlassian_atlassian__getJiraIssue', 'mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__atlassian2__getJiraIssue', 'getJiraIssue',
  ])('denies %s, whatever its arguments', (tool) => {
    expect(check(tool, { cloudId: SITE.id, issueIdOrKey: 'PORT-42', file_path: 'README.md', command: 'true' })).toBe(
      `the ${tool} tool is not allowed: a Jira run may call only getJiraIssue and getAccessibleAtlassianResources`,
    );
  });

  it('passes StructuredOutput only for the fetch, which answers with a schema', () => {
    expect(check('StructuredOutput', { tickets: [] }, FETCH)).toBeUndefined();
    expect(check('StructuredOutput', { tickets: [] }, TEST_RUN)).toBe('the StructuredOutput tool is not allowed: this Jira run answers no schema');
    expect(check('StructuredOutput', {}, PROBE)).toBe('the StructuredOutput tool is not allowed: this Jira run answers no schema');
  });

  it('denies every call when a read root is set, which no Jira run names', () => {
    expect(check('mcp__claude_ai_Atlassian_MCP__getJiraIssue', { cloudId: SITE.id, issueIdOrKey: 'PORT-42' }, FETCH, '/copy')).toBe(
      'a Jira run names no read root, yet SECOND_LOOK_READ_ROOT is set, so no tool may run',
    );
    expect(check('StructuredOutput', {}, FETCH, '/copy')).toMatch(/names no read root/);
  });
});

describe('readJiraGuardLimits', () => {
  it('reads a site and whether the run answers, and nothing else', () => {
    expect(readJiraGuardLimits(JSON.stringify(FETCH))).toEqual(FETCH);
    expect(readJiraGuardLimits('{"answer":false}')).toEqual(PROBE);
    expect(readJiraGuardLimits('{"answer":true,"site":{"id":"x","url":"https://a.atlassian.net"},"extra":1}')).toEqual({ answer: true, site: { id: 'x', url: 'https://a.atlassian.net' } });
  });

  it.each(['', 'jira', '1', 'true', '{}', '[]', '{"answer":"yes"}', '{"answer":true,"site":"x"}', '{"answer":true,"site":{"id":"","url":"https://a.atlassian.net"}}', '{"answer":true,"site":{"url":"https://a.atlassian.net"}}'])(
    'can’t read %j',
    (text) => expect(readJiraGuardLimits(text)).toBeUndefined(),
  );
});

describe('answerPreToolUse in Jira mode', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'second-look-jira-guard-'));
  });

  const event = (tool: string, input: Record<string, unknown>, id = 'toolu_1') =>
    JSON.stringify({ hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: tool, tool_input: input, tool_use_id: id });
  const jiraEnv = (limits: JiraGuardLimits | string, audit?: string): NodeJS.ProcessEnv => ({
    [JIRA_GUARD_VARIABLE]: typeof limits === 'string' ? limits : JSON.stringify(limits),
    ...(audit ? { SECOND_LOOK_GUARD_AUDIT: audit } : {}),
  });
  const decision = (answer: ReturnType<typeof answerPreToolUse>) => (answer.stdout === '' ? undefined : (JSON.parse(answer.stdout) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput);

  it('passes an allowed Jira call with no answer: never allow, and never a rewritten input', () => {
    const answer = answerPreToolUse(event('mcp__claude_ai_Atlassian_MCP__getJiraIssue', { cloudId: SITE.id, issueIdOrKey: 'PORT-42' }), jiraEnv(FETCH), base);
    expect(answer).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('denies through the permission decision, with no allow and no updated input', () => {
    const calls: [string, Record<string, unknown>][] = [
      ['mcp__claude_ai_Atlassian_MCP__getJiraIssue', { cloudId: OTHER_SITE_ID, issueIdOrKey: 'PORT-42' }],
      ['mcp__claude_ai_Atlassian_MCP__createJiraIssue', { cloudId: SITE.id, projectKey: 'PORT', summary: 'x' }],
      ['mcp__atlassian__executeWrite', { cloudId: SITE.id }],
      ['Read', { file_path: 'README.md' }],
      ['Bash', { command: 'curl https://example.invalid' }],
    ];
    for (const [tool, input] of calls) {
      const answer = answerPreToolUse(event(tool, input), jiraEnv(FETCH), base);
      expect(answer.exitCode).toBe(0);
      expect(decision(answer)).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/^Refused by Second Look: /) });
    }
  });

  it('denies every call, Jira’s own read tools included, when the Jira limits can’t be read', () => {
    for (const text of ['', 'not json', '{"site":{}}']) {
      const answer = answerPreToolUse(event('mcp__claude_ai_Atlassian_MCP__getAccessibleAtlassianResources', {}), jiraEnv(text), base);
      expect(decision(answer)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining("can't be read") });
    }
    // Nor does an unreadable Jira mode fall back to the file-reading checks.
    const read = answerPreToolUse(event('Read', { file_path: 'README.md' }), { ...jiraEnv('oops'), SECOND_LOOK_READ_ROOT: base }, base);
    expect(decision(read)).toMatchObject({ permissionDecision: 'deny' });
  });

  it('writes one audit line per Jira call, passed or denied', () => {
    const audit = join(base, 'audit.jsonl');
    answerPreToolUse(event('mcp__claude_ai_Atlassian_MCP__getAccessibleAtlassianResources', {}, 'toolu_a'), jiraEnv(FETCH, audit), base);
    answerPreToolUse(event('mcp__claude_ai_Atlassian_MCP__getJiraIssue', { cloudId: OTHER_SITE_ID, issueIdOrKey: 'PORT-42' }, 'toolu_b'), jiraEnv(FETCH, audit), base);
    answerPreToolUse(event('StructuredOutput', { tickets: [] }, 'toolu_c'), jiraEnv(FETCH, audit), base);
    expect(readFileSync(audit, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 'toolu_a', tool: 'mcp__claude_ai_Atlassian_MCP__getAccessibleAtlassianResources', decision: 'pass' },
      { id: 'toolu_b', tool: 'mcp__claude_ai_Atlassian_MCP__getJiraIssue', decision: 'deny' },
      { id: 'toolu_c', tool: 'StructuredOutput', decision: 'pass' },
    ]);
  });

  it('keeps a review run in file-read mode: without the Jira variable, Jira tools are denied and reads are confined', () => {
    const review = { SECOND_LOOK_READ_ROOT: base };
    const jira = answerPreToolUse(event('mcp__claude_ai_Atlassian_MCP__getJiraIssue', { cloudId: SITE.id, issueIdOrKey: 'PORT-42' }), review, base);
    expect(decision(jira)).toMatchObject({ permissionDecisionReason: 'Refused by Second Look: the mcp__claude_ai_Atlassian_MCP__getJiraIssue tool is not allowed: only Read, Grep, Glob may run' });
  });
});

describe('which runs are in Jira mode', () => {
  it('never a review run, even when the engine’s own environment holds the Jira variable', () => {
    const inherited = { PATH: '/bin', [JIRA_GUARD_VARIABLE]: JSON.stringify(FETCH) };
    expect(claudeEnvironment(inherited)).not.toHaveProperty(JIRA_GUARD_VARIABLE);
    const review = claudeRunEnvironment(inherited, '/copy', '/audit.jsonl');
    expect(review).not.toHaveProperty(JIRA_GUARD_VARIABLE);
    expect(review['SECOND_LOOK_READ_ROOT']).toBe('/copy');
  });

  it('every Jira run, with its own limits and no read root, whatever the engine’s environment held', () => {
    const inherited = { PATH: '/bin', SECOND_LOOK_READ_ROOT: '/copy', GITHUB_TOKEN: 'ghp_x', [JIRA_GUARD_VARIABLE]: '{"answer":true}' };
    const site = { ...SITE, name: 'Your Team' };
    const env = jiraRunEnvironment(inherited, jiraGuardLimits(site, true), '/audit.jsonl');
    expect(readJiraGuardLimits(env[JIRA_GUARD_VARIABLE]!)).toEqual(FETCH);
    expect(env).not.toHaveProperty('SECOND_LOOK_READ_ROOT');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env['SECOND_LOOK_GUARD_AUDIT']).toBe('/audit.jsonl');
    expect(readJiraGuardLimits(jiraRunEnvironment(inherited, jiraGuardLimits(undefined, false), '/a')[JIRA_GUARD_VARIABLE]!)).toEqual(PROBE);
  });
});

describe('the guard hook process in Jira mode', () => {
  const runHook = (tool: string, input: Record<string, unknown>, limits: JiraGuardLimits) =>
    spawnSync(process.execPath, [CLAUDE_GUARD], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't' }),
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], [JIRA_GUARD_VARIABLE]: JSON.stringify(limits) },
    });

  it('passes the chosen site’s ticket and denies a wrong cloudId, as the bundled hook', () => {
    const passed = runHook('mcp__atlassian__getJiraIssue', { cloudId: SITE.id, issueIdOrKey: 'PORT-42' }, TEST_RUN);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toBe('');
    const denied = runHook('mcp__atlassian__getJiraIssue', { cloudId: OTHER_SITE_ID, issueIdOrKey: 'PORT-42' }, TEST_RUN);
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Refused by Second Look: the cloudId must be the chosen Jira site' } });
  });
});
