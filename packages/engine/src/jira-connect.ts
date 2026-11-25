import { spawn } from 'node:child_process';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { trackAgentChild } from './agent-children.js';
import { removeCopy } from './cache.js';
import { CLAUDE_PERMISSION_MODE, claudeEnvironment } from './claude-code.js';
import { READ_ROOT_VARIABLE } from './read-guard.js';
import { isTicketKey } from './ticket-keys.js';

/**
 * The tracker login's check for Jira (ADR 0010, issue 191): whether the
 * reviewer's Claude Code reaches Jira through its Atlassian connector,
 * which Jira sites it reaches, and one ticket fetched on the reviewer's
 * word. It is the setup step's check only: no review reads Jira through
 * it.
 *
 * Each check is one short print-mode run of Claude Code with the fetch
 * run's limits: an empty temporary folder made read-only, with no
 * `SECOND_LOOK_READ_ROOT`; no built-in tool (`--tools ""`); only the
 * Atlassian read tools pre-approved by their full `mcp__…` names; the
 * default permission mode with permission prompts denied, so every other
 * tool, the connector's write tools included, is refused rather than
 * asked about; and no session file. What it reports is read from the
 * run's own events — the start event's MCP servers and the raw tool
 * results Jira sent — never from the model's answer, and a run that
 * called any other tool, or ran in another permission mode, reports
 * nothing it read.
 *
 * The claude.ai Atlassian connector can't be named in `--mcp-config`, so
 * the connector's run drops `--strict-mcp-config` and the reviewer's
 * other connectors load too; the allow-list and the permission mode are
 * what keep them from being called. A reviewer without the connector
 * signs in Second Look's fallback entry for Atlassian's own MCP server
 * once, and its run keeps `--strict-mcp-config` with only that server.
 */

/** The claude.ai Atlassian connector's MCP server, as Claude Code names it in a print-mode run (J0, issue 188). */
export const JIRA_CONNECTOR_SERVER = 'claude_ai_Atlassian_MCP';

/** The fallback's MCP server: Atlassian's Rovo MCP server, added and signed in by the reviewer under this name. */
export const JIRA_FALLBACK_SERVER = 'atlassian';

/** The fallback server's address, the one the reviewer's `claude mcp add` names. */
export const JIRA_FALLBACK_URL = 'https://mcp.atlassian.com/v2/mcp';

/** How a run reaches Jira: the claude.ai connector, or the fallback server. */
export type JiraRoute = 'connector' | 'fallback';

/** The MCP server each route loads. */
export const JIRA_SERVERS: Record<JiraRoute, string> = { connector: JIRA_CONNECTOR_SERVER, fallback: JIRA_FALLBACK_SERVER };

/** The two Jira read tools a route's run may call, by their full names. */
export function jiraTools(route: JiraRoute): { issue: string; resources: string } {
  const server = JIRA_SERVERS[route];
  return { issue: `mcp__${server}__getJiraIssue`, resources: `mcp__${server}__getAccessibleAtlassianResources` };
}

/** The `--mcp-config` the fallback's run names, its only MCP server. */
export const JIRA_FALLBACK_MCP_CONFIG = JSON.stringify({ mcpServers: { [JIRA_FALLBACK_SERVER]: { type: 'http', url: JIRA_FALLBACK_URL } } });

/** One Jira site the reviewer's Atlassian account reaches, as Jira listed it. */
export interface JiraSite {
  /** The site's cloud id, which Jira's tools take as `cloudId`. */
  id: string;
  /** The site's address, such as `https://your-team.atlassian.net`. */
  url: string;
  name: string;
}

/** Whether Claude Code reaches Jira, as the check found it. */
export type JiraProbeResult =
  | { state: 'connected'; route: JiraRoute; sites: JiraSite[] }
  | { state: 'needs-login'; route: JiraRoute; detail: string }
  | { state: 'not-configured' }
  | { state: 'failed'; message: string };

/** One ticket the test fetched: its key and summary, as Jira sent them; or why none was. */
export type JiraTestResult = { ok: true; key: string; summary: string } | { ok: false; message: string };

/** A Jira site setting's host: `your-team.atlassian.net`, one label before `atlassian.net`. */
const SITE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

/**
 * Reads the `second-look.jira.site` setting: empty is no setting, and
 * anything else must be a Jira Cloud site's host, such as
 * `your-team.atlassian.net`, written with or without `https://` and a
 * trailing `/`. Returns the host in lower case, or why the setting can't
 * be used.
 */
export function jiraSiteSetting(value: string): { host?: string } | { problem: string } {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return {};
  const host = trimmed.replace(/^https:\/\//, '').replace(/\/$/, '');
  if (SITE_HOST.test(host)) return { host };
  return { problem: `the Jira site setting must be a Jira Cloud site such as your-team.atlassian.net, not ${JSON.stringify(value.trim())}` };
}

/** A site's host, in lower case, or empty when its address isn't an https address. */
export function jiraSiteHost(site: Pick<JiraSite, 'url'>): string {
  try {
    const url = new URL(site.url);
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Which site the checks read from, as ADR 0010 chooses it. */
export type JiraSiteChoice =
  | { state: 'chosen'; site: JiraSite }
  | { state: 'none' }
  | { state: 'several'; sites: JiraSite[] }
  | { state: 'not-reached'; host: string; sites: JiraSite[] };

/**
 * The Jira site, chosen from those the account reaches: the one the
 * setting names, else the account's only one. With several and no
 * setting, none is chosen and the sites are named; a setting naming a
 * site the account doesn't reach chooses none either. The chosen site is
 * the only `cloudId` a fetch may use.
 */
export function chooseJiraSite(sites: readonly JiraSite[], host: string | undefined): JiraSiteChoice {
  if (host !== undefined) {
    const site = sites.find((each) => jiraSiteHost(each) === host);
    return site === undefined ? { state: 'not-reached', host, sites: [...sites] } : { state: 'chosen', site };
  }
  if (sites.length === 0) return { state: 'none' };
  if (sites.length === 1) return { state: 'chosen', site: sites[0]! };
  return { state: 'several', sites: [...sites] };
}

/**
 * The exact arguments of a Jira check's run: print mode, streamed JSON
 * (which print mode gives only with `--verbose`), no session file, user-level settings only, no built-in tool, only the
 * named tools pre-approved, permission prompts denied and the default
 * permission mode. The fallback's run names its one MCP server and
 * ignores every other; the connector's can't, so it loads the account's
 * connectors. The prompt goes on stdin.
 */
export function jiraRunArguments(route: JiraRoute, allowed: readonly string[], instructions: string, model?: string): string[] {
  const servers = route === 'fallback' ? ['--strict-mcp-config', '--mcp-config', JIRA_FALLBACK_MCP_CONFIG] : [];
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    'user',
    ...servers,
    '--tools',
    '',
    '--allowedTools',
    allowed.join(','),
    '--permission-prompts',
    'none',
    '--permission-mode',
    CLAUDE_PERMISSION_MODE,
    '--system-prompt',
    instructions,
    ...(model ? ['--model', model] : []),
  ];
}

/** The check's system prompt: what the run is for, and that nothing else may be done. */
export const JIRA_CHECK_INSTRUCTIONS = [
  'You are checking that Second Look can read Jira through the Atlassian tools you have.',
  'Call only the one Atlassian tool the task names, once, with exactly the arguments it gives,',
  'then reply with the single word done. Call no other tool, and never repeat what the tool returned.',
].join('\n');

/** The site-list tools a probe may call: the connector's and the fallback's, whichever the account has. */
export const JIRA_PROBE_TOOLS = [jiraTools('connector').resources, jiraTools('fallback').resources] as const;

/** The probe's task: list the sites the account reaches. */
export function jiraProbePrompt(): string {
  return ['Call whichever of these tools you have, once, with no arguments:', ...JIRA_PROBE_TOOLS.map((name) => `- ${name}`)].join('\n');
}

/** The test's task: fetch one ticket from the chosen site. */
export function jiraTestPrompt(route: JiraRoute, site: JiraSite, key: string): string {
  const args = JSON.stringify({ cloudId: site.id, issueIdOrKey: key });
  return `Call ${jiraTools(route).issue} once, with these arguments: ${args}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One MCP server as the run's start event lists it. */
interface StartedServer {
  name: string;
  status: string;
}

/** The run's start event: its MCP servers and permission mode; undefined when the events hold none. */
export function jiraStart(events: readonly unknown[]): { servers: StartedServer[]; permissionMode: string } | undefined {
  const init = events.find((event) => isRecord(event) && event['type'] === 'system' && event['subtype'] === 'init');
  if (!isRecord(init)) return undefined;
  const listed = Array.isArray(init['mcp_servers']) ? init['mcp_servers'] : [];
  const servers = listed.flatMap((server) =>
    isRecord(server) && typeof server['name'] === 'string' ? [{ name: server['name'], status: typeof server['status'] === 'string' ? server['status'] : '' }] : [],
  );
  return { servers, permissionMode: typeof init['permissionMode'] === 'string' ? init['permissionMode'] : '' };
}

/** What a server's start status says: it can be called, it needs a sign-in, or it is off or failed. */
function serverReady(status: string): boolean {
  return status === 'connected' || status === 'pending';
}

/**
 * Which route the start event offers, and whether its server is
 * connected: the connector before the fallback, a connected one before
 * one that isn't. Undefined when neither server is listed.
 */
export function jiraRouteFromStart(servers: readonly StartedServer[]): { route: JiraRoute; status: string } | undefined {
  const listed = (['connector', 'fallback'] as const).flatMap((route) => {
    const server = servers.find((each) => each.name === JIRA_SERVERS[route]);
    return server === undefined ? [] : [{ route, status: server.status }];
  });
  return listed.find((each) => serverReady(each.status)) ?? listed[0];
}

/** What a server that can't be called needs, in plain words, from its start status. */
function loginDetail(status: string): string {
  if (status === 'needs-auth') return 'Claude Code reports the Atlassian connection needs a sign-in';
  if (status === 'disabled') return 'Claude Code reports the Atlassian connection is turned off';
  if (status === 'failed') return 'Claude Code reports the Atlassian connection failed; it usually needs a fresh sign-in';
  return `Claude Code reports the Atlassian connection as ${JSON.stringify(status)}`;
}

/** One tool call the run made, and the raw result Jira sent for it. */
interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: { text: string; isError: boolean };
}

/** A tool result's text: a string, or the text of its text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [])).join('\n');
}

/** Every tool call the run's events show, each with the raw result the run was sent for it. */
export function jiraToolCalls(events: readonly unknown[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event['message'])) continue;
    const content = event['message']['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (event['type'] === 'assistant' && block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
        calls.set(block['id'], { id: block['id'], name: block['name'], input: isRecord(block['input']) ? block['input'] : {} });
      }
      if (event['type'] === 'user' && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        const call = calls.get(block['tool_use_id']);
        if (call !== undefined) call.result = { text: resultText(block['content']), isError: block['is_error'] === true };
      }
    }
  }
  return [...calls.values()];
}

/** The tool calls Claude Code refused itself, by id, from the run's result event. */
function deniedCalls(events: readonly unknown[]): Set<string> {
  const denied = new Set<string>();
  for (const event of events) {
    if (!isRecord(event) || event['type'] !== 'result' || !Array.isArray(event['permission_denials'])) continue;
    for (const denial of event['permission_denials']) if (isRecord(denial) && typeof denial['tool_use_id'] === 'string') denied.add(denial['tool_use_id']);
  }
  return denied;
}

/**
 * Why nothing the run read may be used, in plain words: it ran in
 * another permission mode, or it called a tool outside the allow-list
 * that Claude Code didn't refuse. Undefined when the run kept to its
 * limits.
 */
export function jiraRunBreach(events: readonly unknown[], allowed: readonly string[]): string | undefined {
  const start = jiraStart(events);
  if (start !== undefined && start.permissionMode !== CLAUDE_PERMISSION_MODE) {
    return `Claude Code ran in the ${start.permissionMode === '' ? 'unreported' : start.permissionMode} permission mode instead of ${CLAUDE_PERMISSION_MODE}, so nothing it read is used`;
  }
  const denied = deniedCalls(events);
  const other = jiraToolCalls(events).filter((call) => !allowed.includes(call.name) && !denied.has(call.id));
  if (other.length > 0) return `Claude Code called ${other.map((call) => call.name).join(', ')}, which the check doesn't allow, so nothing it read is used`;
  return undefined;
}

/** The first line of a text, cut short, for a plain message. */
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Words a refused sign-in uses. */
const SIGN_IN_WORDS = /unauthori[sz]ed|authenticat|oauth|sign(?:ed)? ?in|log ?in|401|403|token/i;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The Jira sites in the raw result of `getAccessibleAtlassianResources`:
 * each resource with an id and an https address, kept when it carries a
 * Jira scope or lists no scopes. Undefined when the result isn't a list.
 */
export function jiraSitesFromResult(text: string): JiraSite[] | undefined {
  const parsed = parseJson(text);
  const listed = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed['resources']) ? parsed['resources'] : undefined;
  if (listed === undefined) return undefined;
  return listed.flatMap((resource) => {
    if (!isRecord(resource) || typeof resource['id'] !== 'string' || typeof resource['url'] !== 'string') return [];
    const scopes = resource['scopes'];
    if (Array.isArray(scopes) && !scopes.some((scope) => typeof scope === 'string' && scope.includes('jira'))) return [];
    const site = { id: resource['id'], url: resource['url'], name: typeof resource['name'] === 'string' ? resource['name'] : '' };
    return jiraSiteHost(site) === '' ? [] : [site];
  });
}

/**
 * What the probe's events say: the route's server missing from the start
 * event is not configured, listed but not connected needs a login, and
 * connected lists the sites from the raw result of the site-list call.
 */
export function readJiraProbe(events: readonly unknown[]): JiraProbeResult {
  const start = jiraStart(events);
  if (start === undefined) return { state: 'failed', message: 'Claude Code ended before it reported its MCP servers' };
  const found = jiraRouteFromStart(start.servers);
  if (found === undefined) return { state: 'not-configured' };
  if (!serverReady(found.status)) return { state: 'needs-login', route: found.route, detail: loginDetail(found.status) };
  const tools = jiraTools(found.route);
  const breach = jiraRunBreach(events, JIRA_PROBE_TOOLS);
  if (breach !== undefined) return { state: 'failed', message: breach };
  const call = jiraToolCalls(events).find((each) => each.name === tools.resources && each.result !== undefined);
  if (call?.result === undefined) return { state: 'failed', message: 'Claude Code did not ask the Atlassian connection for its Jira sites' };
  if (call.result.isError) {
    const why = firstLine(call.result.text);
    if (SIGN_IN_WORDS.test(why)) return { state: 'needs-login', route: found.route, detail: `Atlassian refused the sign-in: ${why}` };
    return { state: 'failed', message: `Atlassian answered with an error: ${why}` };
  }
  const sites = jiraSitesFromResult(call.result.text);
  if (sites === undefined) return { state: 'failed', message: 'Atlassian answered, but not with a list of sites' };
  return { state: 'connected', route: found.route, sites };
}

/** Whether a call's `cloudId` names the site: its cloud id, its address or its host. */
function namesSite(cloudId: unknown, site: JiraSite): boolean {
  if (typeof cloudId !== 'string') return false;
  const given = cloudId.trim().toLowerCase().replace(/\/$/, '');
  const host = jiraSiteHost(site);
  return given === site.id.toLowerCase() || given === host || given === `https://${host}`;
}

/**
 * What the test's events say about the ticket: its key and summary from
 * the raw result Jira sent for a `getJiraIssue` call on the chosen site
 * and the asked key, or why there's none. A call on any other site or
 * key, or a breach of the run's limits, fails the test.
 */
export function readJiraTest(events: readonly unknown[], route: JiraRoute, site: JiraSite, key: string): JiraTestResult {
  const start = jiraStart(events);
  if (start === undefined) return { ok: false, message: 'Claude Code ended before it reported its MCP servers' };
  const tools = jiraTools(route);
  const server = start.servers.find((each) => each.name === JIRA_SERVERS[route]);
  if (server === undefined || !serverReady(server.status)) return { ok: false, message: 'Claude Code has no Atlassian connection to read Jira through; check the connection again' };
  const breach = jiraRunBreach(events, [tools.issue, tools.resources]);
  if (breach !== undefined) return { ok: false, message: breach };
  const calls = jiraToolCalls(events).filter((call) => call.name === tools.issue);
  const stray = calls.find((call) => !namesSite(call.input['cloudId'], site) || call.input['issueIdOrKey'] !== key);
  if (stray !== undefined) return { ok: false, message: 'Claude Code asked Jira for another site or ticket than the test names, so nothing it read is used' };
  const call = calls.find((each) => each.result !== undefined);
  if (call?.result === undefined) return { ok: false, message: `Claude Code did not ask Jira for ${key}` };
  if (call.result.isError) return { ok: false, message: `Jira did not return ${key}: ${firstLine(call.result.text)}` };
  const issue = parseJson(call.result.text);
  const fields = isRecord(issue) && isRecord(issue['fields']) ? issue['fields'] : undefined;
  if (!isRecord(issue) || issue['key'] !== key || typeof fields?.['summary'] !== 'string') {
    return { ok: false, message: `Jira did not return ${key}: ${firstLine(call.result.text) || 'its answer names no such ticket'}` };
  }
  return { ok: true, key, summary: fields['summary'] };
}

/** How a check starts Claude Code. */
export interface JiraCheckOptions {
  /** The command that starts Claude Code, with any leading arguments. */
  command: readonly string[];
  /** The engine's environment, which the run inherits minus the GitHub login. */
  env: NodeJS.ProcessEnv;
  /** The model to ask for; Claude Code's default when absent. */
  model?: string;
  /** Milliseconds the run may take. */
  timeoutMs?: number;
}

/** A check's environment: the agent's, minus the GitHub login and any read root, so no copy is named to it. */
export function jiraEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = claudeEnvironment(env);
  delete clean[READ_ROOT_VARIABLE];
  return clean;
}

/** What one run left: its events, and how it ended. */
interface JiraRun {
  events: unknown[];
  error?: string;
}

/** Milliseconds a check's run may take by default: one short model turn. */
export const JIRA_CHECK_TIMEOUT_MS = 120_000;

/**
 * Runs Claude Code once with the check's limits, in an empty read-only
 * temporary folder that is removed afterwards, and collects its events.
 * `stop` ends the run early once the events so far settle the answer,
 * such as a start event with no Atlassian server.
 */
async function runJiraCheck(
  options: JiraCheckOptions,
  route: JiraRoute,
  allowed: readonly string[],
  prompt: string,
  stop: (events: readonly unknown[]) => boolean,
): Promise<JiraRun> {
  const root = await mkdtemp(join(tmpdir(), 'second-look-jira-'));
  try {
    await chmod(root, 0o555);
    const args = jiraRunArguments(route, allowed, JIRA_CHECK_INSTRUCTIONS, options.model);
    const child = trackAgentChild(
      spawn(options.command[0]!, [...options.command.slice(1), ...args], { cwd: root, env: jiraEnvironment(options.env), stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);
    const events: unknown[] = [];
    let stderr = '';
    let stopped = false;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const event = parseJson(line);
      if (event === undefined || stopped) return;
      events.push(event);
      if (stop(events)) {
        stopped = true;
        child.kill('SIGTERM');
      }
    });
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? JIRA_CHECK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const exit = await new Promise<{ code: number | null; spawnError?: string }>((done) => {
      child.on('error', (error) => done({ code: null, spawnError: error.message }));
      child.on('close', (code) => done({ code }));
    });
    clearTimeout(timer);
    lines.close();
    if (exit.spawnError !== undefined) return { events, error: `Claude Code could not be started: ${exit.spawnError}` };
    if (timedOut) return { events, error: `Claude Code did not finish within ${Math.round(timeoutMs / 1000)} seconds` };
    if (!stopped && exit.code !== 0 && jiraStart(events) === undefined) {
      const detail = stderr.trim() === '' ? '' : `: ${firstLine(stderr.trim().split('\n').slice(-1)[0] ?? '')}`;
      return { events, error: `Claude Code exited with ${exit.code}${detail}` };
    }
    return { events };
  } finally {
    await removeCopy(root);
  }
}

/** Whether a probe's events so far already settle it: the start event lists no server it can call. */
function probeSettled(events: readonly unknown[]): boolean {
  const start = jiraStart(events);
  if (start === undefined) return false;
  const found = jiraRouteFromStart(start.servers);
  return found === undefined || !serverReady(found.status);
}

/**
 * Checks the tracker login, fetching no ticket: one run that lists the
 * Jira sites the account reaches, with only the site-list tool of each
 * route pre-approved. A run whose start event names no Atlassian server,
 * or one that needs a sign-in, is stopped there, before any model turn.
 */
export async function probeJira(options: JiraCheckOptions): Promise<JiraProbeResult> {
  const run = await runJiraCheck(options, 'connector', JIRA_PROBE_TOOLS, jiraProbePrompt(), probeSettled);
  const result = readJiraProbe(run.events);
  if (run.error !== undefined && result.state === 'failed') return { state: 'failed', message: run.error };
  return result;
}

/**
 * Fetches the one ticket the reviewer typed, from the chosen site, with
 * the fetch run's limits and its two tools pre-approved. Only the key and
 * summary Jira sent are reported; nothing is kept.
 */
export async function testJiraFetch(options: JiraCheckOptions, route: JiraRoute, site: JiraSite, key: string): Promise<JiraTestResult> {
  if (!isTicketKey(key)) return { ok: false, message: `${JSON.stringify(key)} is not a Jira ticket key such as ABC-123` };
  const tools = jiraTools(route);
  const run = await runJiraCheck(options, route, [tools.issue, tools.resources], jiraTestPrompt(route, site, key), () => false);
  const result = readJiraTest(run.events, route, site, key);
  if (run.error !== undefined && !result.ok) return { ok: false, message: run.error };
  return result;
}
