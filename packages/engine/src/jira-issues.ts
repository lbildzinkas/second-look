import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countAgentRun, hasAgentRunLeft, limitReason, type BudgetMeter } from './budget.js';
import { STRUCTURED_OUTPUT_TOOL } from './claude-guard-check.js';
import type { IssueTrackerSource, LinkedIssuesRead } from './issue-sources.js';
import {
  chooseJiraSite,
  fetchJiraTickets,
  firstLine,
  JIRA_CHECK_TIMEOUT_MS,
  JIRA_FETCH_TIMEOUT_MS,
  jiraFetchCallNames,
  jiraRunBreach,
  jiraStart,
  jiraToolCalls,
  parseJson,
  probeJira,
  serverReady,
  type JiraCheckOptions,
  type JiraRun,
} from './jira-connect.js';
import { flattenJiraDescription, jiraCriteriaSection, quoteForm } from './jira-text.js';
import { JIRA_SERVERS, jiraSiteHost, jiraTools, namesJiraSite, type JiraRoute, type JiraSite } from './jira-tools.js';
import type { JiraLinkedIssue } from './protocol.js';
import { MAX_KEY_REFERENCES } from './ticket-keys.js';

/**
 * The Jira issue tracker source (ADR 0010, issue 192): the tickets the
 * pull request's key references name, read through the reviewer's
 * Claude Code in a fetch run of their own (`jira-connect.ts`), and
 * checked field by field against what Jira itself sent.
 *
 * The model only drives the calls. Each field its answer quotes — the
 * summary, the description and the criteria section — must appear word
 * for word, in {@link quoteForm}, in the raw `tool_result` Jira sent for
 * that key; a ticket with any field that doesn't is discarded with a
 * plain reason, never shown or mapped. What a confirmed ticket shows is
 * Jira's own text, from that raw result. A key Jira doesn't return is
 * dropped quietly: Jira answers "not found" both for a missing ticket and
 * for one the reviewer can't see.
 *
 * The site is learned once, from the site-list run, and kept per setting;
 * the project of each confirmed key is kept per site as a visible
 * project, and later reviews fetch the keys of known projects first. A
 * source that can't read says so in its outcome — not connected, nothing
 * found or unreadable — and never fails the review.
 */

/**
 * Milliseconds the whole Jira read may take, its site-list run and its
 * fetch together. The read runs in the review's plain pass, which the
 * editor waits on for two minutes before it gives the engine up, so a
 * slow Jira run ends the Jira read as unreadable rather than the review.
 */
export const JIRA_READ_DEADLINE_MS = 90_000;

/** How the review reaches Jira: through Claude Code, or not at all, saying why. */
export type JiraReach =
  | {
      /** How the fetch run starts Claude Code. */
      run: JiraCheckOptions;
      /** Why Claude Code can't run with the companion's lockdown; undefined when it can. Asked before any Jira run. */
      lockdown?: () => Promise<string | undefined>;
    }
  | {
      /** Why this review reads no Jira, such as Pi, which has no MCP and runs offline. */
      unavailable: string;
    };

/** What the Jira source needs besides the pull request. */
export interface JiraSourceOptions {
  reach: JiraReach;
  /** The `second-look.jira.site` setting's host, which picks the site when the account reaches several; absent when unset. */
  site?: string;
  /** The heading the criteria section sits under. */
  heading: string;
  /** The engine's cache folder, which keeps the chosen site and the visible projects. */
  cacheDir: string;
  /** Counts each Jira run as an agent run, and starts none past the limit. */
  budget?: BudgetMeter;
  /** Milliseconds the whole read may take; {@link JIRA_READ_DEADLINE_MS} by default. */
  deadlineMs?: number;
}

/** One ticket the fetch confirmed: its key, and its summary and description as Jira sent them. */
export interface JiraTicket {
  key: string;
  summary: string;
  /** The description, flattened to lines. */
  description: string;
}

/** What the fetch run's events came to, checked against the raw tool results. */
export interface JiraFetchRead {
  /** The tickets confirmed, in the order the keys were asked for. */
  tickets: JiraTicket[];
  /** The tickets Jira sent that were discarded, each with why. */
  discarded: { key: string; reason: string }[];
  /** How many keys Jira sent a ticket for, confirmed or discarded. */
  returned: number;
  /** Why nothing the run read may be used, when that is so. */
  failure?: string;
  /** Why the run couldn't reach Jira, when its route's server wasn't there to call. */
  notConnected?: string;
  /** True when Jira refused the site itself, not a ticket, so the site kept for it may be stale. */
  siteRefused?: boolean;
}

/** Words of an error that refuses the site or the sign-in rather than one ticket. */
const SITE_REFUSED = /cloud ?id|unauthori[sz]ed|\b401\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every string a raw result holds, its own text first, then each string inside its JSON. */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const each of value) stringsOf(each, into);
  else if (isRecord(value)) for (const each of Object.values(value)) stringsOf(each, into);
  return into;
}

/** One key's raw ticket, as Jira sent it: its fields, and every text it holds in quote form. */
interface RawTicket {
  summary: string;
  description: string;
  texts: string[];
}

/** The ticket a raw `getJiraIssue` result holds for the key, or undefined when it holds none. */
function rawTicket(text: string, key: string): RawTicket | undefined {
  const issue = parseJson(text);
  const fields = isRecord(issue) && isRecord(issue['fields']) ? issue['fields'] : undefined;
  if (!isRecord(issue) || issue['key'] !== key || typeof fields?.['summary'] !== 'string') return undefined;
  const description = flattenJiraDescription(fields['description']);
  const texts = [text, description, ...stringsOf(issue)].map(quoteForm).filter((each) => each !== '');
  return { summary: fields['summary'], description, texts };
}

/** Whether a quoted field appears word for word, in quote form, in one of a raw ticket's texts; an empty field quotes nothing. */
function quotedFrom(field: string, raw: RawTicket): boolean {
  const quote = quoteForm(field);
  return quote === '' || raw.texts.some((text) => ` ${text} `.includes(` ${quote} `));
}

/** The fetch's answer: from the result event's structured output, else the answer tool's input, else the result's text. */
function fetchAnswer(events: readonly unknown[]): unknown {
  const result = [...events].reverse().find((event) => isRecord(event) && event['type'] === 'result');
  if (isRecord(result) && isRecord(result['structured_output'])) return result['structured_output'];
  const answered = jiraToolCalls(events).reverse().find((call) => call.name === STRUCTURED_OUTPUT_TOOL);
  if (answered !== undefined) return answered.input;
  return isRecord(result) && typeof result['result'] === 'string' ? parseJson(result['result']) : undefined;
}

/** The answer's tickets, each with its four quoted fields; undefined when the answer isn't that shape. */
function answeredTickets(answer: unknown): { key: string; summary: string; description: string; criteria: string }[] | undefined {
  if (!isRecord(answer) || !Array.isArray(answer['tickets'])) return undefined;
  const tickets = answer['tickets'];
  const fields = ['key', 'summary', 'description', 'criteria'] as const;
  if (!tickets.every((ticket) => isRecord(ticket) && fields.every((field) => typeof ticket[field] === 'string'))) return undefined;
  return tickets as { key: string; summary: string; description: string; criteria: string }[];
}

/**
 * Reads the fetch run's events for the keys asked, model-free: the run
 * must have kept to its limits and asked only the chosen site for only
 * those keys; each key's ticket is the raw result Jira sent for it; and
 * each ticket the answer quotes is confirmed only when its summary,
 * description and criteria section all appear in that raw result, word
 * for word. A key Jira didn't send is dropped quietly; one the answer
 * left out, or quoted wrongly, is discarded, saying why.
 */
export function readJiraFetch(events: readonly unknown[], route: JiraRoute, site: JiraSite, keys: readonly string[]): JiraFetchRead {
  const read: JiraFetchRead = { tickets: [], discarded: [], returned: 0 };
  const start = jiraStart(events);
  if (start === undefined) return { ...read, failure: 'Claude Code ended before it reported its MCP servers' };
  const server = start.servers.find((each) => each.name === JIRA_SERVERS[route]);
  if (server === undefined || !serverReady(server.status)) {
    return { ...read, notConnected: 'Claude Code has no Atlassian connection to read Jira through; connect Jira in the setup step' };
  }
  const breach = jiraRunBreach(events, jiraFetchCallNames(route));
  if (breach !== undefined) return { ...read, failure: breach };
  const calls = jiraToolCalls(events).filter((call) => call.name === jiraTools(route).issue);
  const asked = new Set(keys);
  const stray = calls.find((call) => !namesJiraSite(call.input['cloudId'], site) || typeof call.input['issueIdOrKey'] !== 'string' || !asked.has(call.input['issueIdOrKey']));
  if (stray !== undefined) return { ...read, failure: 'Claude Code asked Jira for another site or ticket than the review names, so nothing it read is used' };

  const raw = new Map<string, RawTicket>();
  for (const call of calls) {
    const key = call.input['issueIdOrKey'] as string;
    if (call.result === undefined || call.result.isError || raw.has(key)) continue;
    const ticket = rawTicket(call.result.text, key);
    if (ticket !== undefined) raw.set(key, ticket);
  }
  read.returned = raw.size;
  if (raw.size === 0) return { ...read, siteRefused: calls.some((call) => call.result?.isError === true && SITE_REFUSED.test(call.result.text)) };
  const answered = answeredTickets(fetchAnswer(events));
  if (answered === undefined) return { ...read, failure: "Claude Code's answer isn't the tickets it was asked to quote, so no ticket is used" };

  const checked = new Map<string, string | undefined>();
  for (const ticket of answered) {
    const found = raw.get(ticket.key);
    if (found === undefined || checked.has(ticket.key)) continue;
    const wrong = (['summary', 'description', 'criteria'] as const).find((field) => !quotedFrom(ticket[field], found));
    checked.set(ticket.key, quoteForm(ticket.summary) === '' ? 'its summary is missing from the answer' : wrong && `its ${wrong === 'criteria' ? 'criteria section' : wrong} doesn't match what Jira sent`);
  }
  for (const key of keys) {
    const found = raw.get(key);
    if (found === undefined) continue;
    if (!checked.has(key)) read.discarded.push({ key, reason: "Claude Code's answer left it out" });
    else if (checked.get(key) !== undefined) read.discarded.push({ key, reason: checked.get(key)! });
    else read.tickets.push({ key, summary: found.summary, description: found.description });
  }
  return read;
}

/** A Jira project key: the part of a ticket key before its number. */
export function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf('-'));
}

/**
 * The keys in the order they are fetched: those of projects the site has
 * confirmed before first, then the rest, each group in the order the
 * pull request names them, at most {@link MAX_KEY_REFERENCES}.
 */
export function orderByVisibleProjects(keys: readonly string[], projects: ReadonlySet<string>, cap: number = MAX_KEY_REFERENCES): string[] {
  const known = keys.filter((key) => projects.has(projectOf(key)));
  const rest = keys.filter((key) => !projects.has(projectOf(key)));
  return [...known, ...rest].slice(0, cap);
}

/** A site id that may name a cache folder. */
const SITE_ID = /^[A-Za-z0-9-]{1,100}$/;

/** The Jira cache's folder in the engine's cache. */
function jiraCacheDir(cacheDir: string): string {
  return join(cacheDir, 'jira');
}

/** The file the site's visible projects are kept in; undefined when the site's id can't name a folder. */
function projectsFile(cacheDir: string, site: Pick<JiraSite, 'id'>): string | undefined {
  return SITE_ID.test(site.id) ? join(jiraCacheDir(cacheDir), 'sites', site.id, 'projects.json') : undefined;
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return parseJson(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The projects the site confirmed tickets of in earlier reviews; none when nothing is kept. */
export async function readVisibleProjects(cacheDir: string, site: Pick<JiraSite, 'id'>): Promise<Set<string>> {
  const file = projectsFile(cacheDir, site);
  const kept = file === undefined ? undefined : await readJsonFile(file);
  const projects = isRecord(kept) && Array.isArray(kept['projects']) ? kept['projects'] : [];
  return new Set(projects.filter((project): project is string => typeof project === 'string'));
}

/** Adds the projects of the confirmed keys to the site's visible projects. */
export async function rememberVisibleProjects(cacheDir: string, site: Pick<JiraSite, 'id'>, keys: readonly string[]): Promise<void> {
  const file = projectsFile(cacheDir, site);
  if (file === undefined || keys.length === 0) return;
  const projects = await readVisibleProjects(cacheDir, site);
  for (const key of keys) projects.add(projectOf(key));
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${JSON.stringify({ projects: [...projects].sort() })}\n`);
}

/** The file the chosen site is kept in. */
function siteFile(cacheDir: string): string {
  return join(jiraCacheDir(cacheDir), 'site.json');
}

/** The route and site chosen for the setting, as an earlier review kept them; undefined when none is kept for it. */
async function readChosenSite(cacheDir: string, setting: string | undefined): Promise<{ route: JiraRoute; site: JiraSite } | undefined> {
  const kept = await readJsonFile(siteFile(cacheDir));
  if (!isRecord(kept) || kept['setting'] !== (setting ?? '') || (kept['route'] !== 'connector' && kept['route'] !== 'fallback')) return undefined;
  const site = kept['site'];
  if (!isRecord(site) || typeof site['id'] !== 'string' || !SITE_ID.test(site['id']) || typeof site['url'] !== 'string' || typeof site['name'] !== 'string') return undefined;
  if (jiraSiteHost({ url: site['url'] }) === '') return undefined;
  return { route: kept['route'], site: { id: site['id'], url: site['url'], name: site['name'] } };
}

async function keepChosenSite(cacheDir: string, setting: string | undefined, route: JiraRoute, site: JiraSite): Promise<void> {
  await mkdir(jiraCacheDir(cacheDir), { recursive: true });
  await writeFile(siteFile(cacheDir), `${JSON.stringify({ setting: setting ?? '', route, site })}\n`);
}

async function forgetChosenSite(cacheDir: string): Promise<void> {
  await rm(siteFile(cacheDir), { force: true });
}

/** Keys as a reader names them: `A`, `A and B`, `A, B and C`. */
function named(keys: readonly string[]): string {
  return keys.length <= 1 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)!}`;
}

/** A source's read with nothing read. */
function none(outcome: LinkedIssuesRead['outcome'], detail: string): LinkedIssuesRead {
  return { issues: [], outcome, detail };
}

/** Why a site couldn't be chosen, in plain words; undefined when one was. */
function noSite(choice: ReturnType<typeof chooseJiraSite>): string | undefined {
  if (choice.state === 'chosen') return undefined;
  if (choice.state === 'none') return 'the Atlassian account reaches no Jira site';
  const hosts = choice.sites.map(jiraSiteHost).join(', ');
  if (choice.state === 'several') return `the Atlassian account reaches several Jira sites (${hosts}); set second-look.jira.site to the one to read`;
  return `the Atlassian account doesn't reach ${choice.host}, the site second-look.jira.site names${hosts === '' ? '' : `; it reaches ${hosts}`}`;
}

/**
 * The Jira issue tracker source. It reads only when the pull request
 * names key references, on Claude Code only: the site the setting or the
 * account's only one chooses, kept from an earlier review or learned in a
 * site-list run, then one fetch run for the keys, those of visible
 * projects first. Each run counts as an agent run of the review's budget.
 */
export function jiraIssues(options: JiraSourceOptions): IssueTrackerSource {
  const meter = options.budget;
  const runLeft = (): string | undefined => (meter === undefined || hasAgentRunLeft(meter) ? undefined : limitReason(meter, 'agentRuns', 'read the Jira tickets'));
  return {
    source: 'jira',
    async readLinkedIssues({ keyReferences }) {
      const keys = (keyReferences ?? []).map((reference) => reference.key);
      if (keys.length === 0) return none('nothing found', 'the pull request names no Jira ticket key');
      const reach = options.reach;
      if ('unavailable' in reach) return none('not connected', reach.unavailable);
      const ends = Date.now() + (options.deadlineMs ?? JIRA_READ_DEADLINE_MS);
      // Each run gets what is left of the read's deadline, or its own timeout when that is shorter.
      const timed = (timeoutMs: number): JiraCheckOptions => ({ ...reach.run, timeoutMs: Math.max(1_000, Math.min(reach.run.timeoutMs ?? timeoutMs, ends - Date.now())) });
      const lockdown = await reach.lockdown?.();
      if (lockdown !== undefined) return none('unreadable', `Jira is read through Claude Code, which can't run with the companion's lockdown: ${lockdown}`);

      let chosen = await readChosenSite(options.cacheDir, options.site);
      if (chosen === undefined) {
        const spent = runLeft();
        if (spent !== undefined) return none('unreadable', spent);
        if (meter) countAgentRun(meter);
        const probe = await probeJira(timed(JIRA_CHECK_TIMEOUT_MS));
        if (probe.state === 'not-configured') return none('not connected', 'Claude Code has no Atlassian connection; connect Jira in the setup step');
        if (probe.state === 'needs-login') return none('not connected', `${probe.detail}; connect Jira in the setup step`);
        if (probe.state === 'failed') return none('unreadable', `the Jira sites could not be listed: ${probe.message}`);
        const choice = chooseJiraSite(probe.sites, options.site);
        const why = noSite(choice);
        if (why !== undefined || choice.state !== 'chosen') return none('not connected', why ?? 'no Jira site is chosen');
        chosen = { route: probe.route, site: choice.site };
        await keepChosenSite(options.cacheDir, options.site, chosen.route, chosen.site).catch(() => undefined);
      }
      const { route, site } = chosen;
      const host = jiraSiteHost(site);
      const order = orderByVisibleProjects(keys, await readVisibleProjects(options.cacheDir, site));

      const spent = runLeft();
      if (spent !== undefined) return none('unreadable', spent);
      if (meter) countAgentRun(meter);
      const run: JiraRun = await fetchJiraTickets(timed(JIRA_FETCH_TIMEOUT_MS), route, site, order, options.heading);
      if (run.unguarded !== undefined) return none('unreadable', `the Jira tickets could not be read: ${run.unguarded}`);
      const read = readJiraFetch(run.events, route, site, order);
      if (read.notConnected !== undefined) {
        await forgetChosenSite(options.cacheDir).catch(() => undefined);
        return none('not connected', read.notConnected);
      }
      if (read.failure !== undefined) return none('unreadable', `the Jira tickets could not be read: ${read.failure}`);
      // A site Jira refuses is learned again by the next review's site-list run.
      if (read.siteRefused === true) await forgetChosenSite(options.cacheDir).catch(() => undefined);
      if (run.error !== undefined && read.returned === 0) return none('unreadable', `the Jira tickets could not be read: ${firstLine(run.error)}`);

      const confirmed = read.tickets.map((ticket) => ticket.key);
      await rememberVisibleProjects(options.cacheDir, site, confirmed).catch(() => undefined);
      const issues: JiraLinkedIssue[] = read.tickets.map((ticket) => ({
        source: 'jira',
        key: ticket.key,
        title: ticket.summary,
        url: `https://${host}/browse/${ticket.key}`,
        body: ticket.description,
        link: 'references',
      }));
      const notes = [
        ...read.tickets.filter((ticket) => jiraCriteriaSection(ticket.description, options.heading) === undefined).map((ticket) => `${ticket.key}: no criteria section found`),
        ...read.discarded.map(({ key, reason }) => `${key} discarded: ${reason}`),
      ];
      const tail = notes.length === 0 ? '' : `; ${notes.join('; ')}`;
      if (issues.length > 0) {
        return { issues, outcome: 'read', detail: `${confirmed.length === 1 ? 'Jira ticket' : 'Jira tickets'} ${named(confirmed)} read from ${host}${tail}` };
      }
      if (read.discarded.length > 0) return none('unreadable', `no Jira ticket could be used${tail}`);
      return none('nothing found', `Jira on ${host} returned none of ${named(order)}`);
    },
  };
}
