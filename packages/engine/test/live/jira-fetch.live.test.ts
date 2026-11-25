import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { jiraIssues, readVisibleProjects } from '../../src/jira-issues.js';
import { jiraSiteSetting } from '../../src/jira-connect.js';
import { CLAUDE_GUARD } from '../fake-claude.js';

/**
 * The live test of the Jira fetch run (ADR 0010, issue 192): it fetches
 * one ticket from a test Jira site through the reviewer's installed,
 * signed-in Claude Code and its Atlassian connection, with the
 * companion's guard hook in its Jira mode, and checks it the way a
 * review does. It spends subscription quota and reaches the test site,
 * so it runs only with `npm run test:live-claude` and only when
 * `SECOND_LOOK_LIVE_JIRA_KEY` names a ticket on a test site, never a
 * real work ticket: the repository is public. `SECOND_LOOK_LIVE_JIRA_SITE`
 * picks the site when the account reaches several, and
 * `SECOND_LOOK_LIVE_CLAUDE` the Claude Code command.
 */

const KEY = process.env['SECOND_LOOK_LIVE_JIRA_KEY'] ?? '';
const SITE = process.env['SECOND_LOOK_LIVE_JIRA_SITE'] ?? '';
const CLAUDE = process.env['SECOND_LOOK_LIVE_CLAUDE'] ?? 'claude';
const RUN_TIMEOUT_MS = 300_000;

const cacheDir = mkdtempSync(join(tmpdir(), 'second-look-live-jira-'));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

describe.skipIf(KEY === '')('the Jira fetch run, live', () => {
  it(
    `fetches ${KEY || 'the test ticket'} and checks every quoted field against what Jira sent`,
    async () => {
      const setting = jiraSiteSetting(SITE);
      if ('problem' in setting) throw new Error(setting.problem);
      const source = jiraIssues({
        reach: { run: { command: [CLAUDE], guardPath: CLAUDE_GUARD, env: process.env } },
        heading: 'Acceptance criteria',
        cacheDir,
        ...(setting.host ? { site: setting.host } : {}),
      });
      const read = await source.readLinkedIssues({ ref: { owner: 'second-look', repo: 'live', number: 1 }, base: 'main', keyReferences: [{ key: KEY, place: 'title' }] });

      expect(read, read.detail).toMatchObject({ outcome: 'read' });
      expect(read.issues).toHaveLength(1);
      expect(read.issues[0]).toMatchObject({ source: 'jira', key: KEY, title: expect.any(String) });
      expect(read.issues[0]!.title.trim()).not.toBe('');
      expect(read.issues[0]!.url).toMatch(new RegExp(`^https://[a-z0-9-]+\\.atlassian\\.net/browse/${KEY}$`));
      // The confirmed key's project is now a visible project of the site.
      const sites = await import('node:fs/promises').then((fs) => fs.readdir(join(cacheDir, 'jira', 'sites')));
      expect(sites).toHaveLength(1);
      expect([...(await readVisibleProjects(cacheDir, { id: sites[0]! }))]).toEqual([KEY.slice(0, KEY.lastIndexOf('-'))]);
    },
    RUN_TIMEOUT_MS,
  );
});
