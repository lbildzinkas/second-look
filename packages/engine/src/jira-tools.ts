/**
 * The names and shapes the Jira fetch run and the guard's Jira mode share
 * (ADR 0010): the two MCP servers a run reaches Jira through, the two
 * read tools each offers, and what a Jira site is. The guard runs as its
 * own process, so this file imports nothing but its siblings' types and
 * the key shape, and `jira-connect.ts` exports the same names.
 */

/** The claude.ai Atlassian connector's MCP server, as Claude Code names it in a print-mode run (J0, issue 188). */
export const JIRA_CONNECTOR_SERVER = 'claude_ai_Atlassian_MCP';

/** The fallback's MCP server: Atlassian's Rovo MCP server, added and signed in by the reviewer under this name. */
export const JIRA_FALLBACK_SERVER = 'atlassian';

/** How a run reaches Jira: the claude.ai connector, or the fallback server. */
export type JiraRoute = 'connector' | 'fallback';

/** The routes, the connector first. */
export const JIRA_ROUTES: readonly JiraRoute[] = ['connector', 'fallback'];

/** The MCP server each route loads. */
export const JIRA_SERVERS: Record<JiraRoute, string> = { connector: JIRA_CONNECTOR_SERVER, fallback: JIRA_FALLBACK_SERVER };

/** The two Jira read tools a route's run may call, by their full names. */
export function jiraTools(route: JiraRoute): { issue: string; resources: string } {
  const server = JIRA_SERVERS[route];
  return { issue: `mcp__${server}__getJiraIssue`, resources: `mcp__${server}__getAccessibleAtlassianResources` };
}

/** One Jira site the reviewer's Atlassian account reaches, as Jira listed it. */
export interface JiraSite {
  /** The site's cloud id, which Jira's tools take as `cloudId`. */
  id: string;
  /** The site's address, such as `https://your-team.atlassian.net`. */
  url: string;
  name: string;
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

/** Whether a call's `cloudId` names the site: its cloud id, its address or its host. */
export function namesJiraSite(cloudId: unknown, site: Pick<JiraSite, 'id' | 'url'>): boolean {
  if (typeof cloudId !== 'string') return false;
  const given = cloudId.trim().toLowerCase().replace(/\/$/, '');
  const host = jiraSiteHost(site);
  if (given === '') return false;
  return given === site.id.toLowerCase() || (host !== '' && (given === host || given === `https://${host}`));
}
