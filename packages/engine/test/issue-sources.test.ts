import { describe, expect, it } from 'vitest';
import type { GitHubClient, GitHubIssue } from '../src/github.js';
import { gitHubIssues, gitHubKey, withIssueSources } from '../src/issue-sources.js';

const ref = { owner: 'example-org', repo: 'example-repo', number: 42 };

const OWN: GitHubIssue = {
  number: 30,
  title: 'Retry failed webhook sends',
  url: 'https://github.com/example-org/example-repo/issues/30',
  repository: 'example-org/example-repo',
  body: '## Acceptance criteria\n- [ ] A send is retried\n',
  link: 'closes',
};

const ELSEWHERE: GitHubIssue = {
  number: 7,
  title: 'Track the webhook retries',
  url: 'https://github.com/example-org/planning/issues/7',
  repository: 'example-org/planning',
  body: '',
  link: 'references',
};

function clientWith(linked: () => Promise<{ defaultBranch: string; issues: GitHubIssue[] }>): GitHubClient {
  return { getLinkedIssues: linked } as unknown as GitHubClient;
}

describe('the GitHub issue tracker source', () => {
  it('lists the issues GitHub links, each GitHub’s with the key it is shown by, its GitHub fields kept', async () => {
    const read = await gitHubIssues(clientWith(async () => ({ defaultBranch: 'master', issues: [OWN, ELSEWHERE] }))).readLinkedIssues({ ref, base: 'master' });

    expect(read).toEqual({
      issues: [
        { source: 'github', key: '#30', ...OWN },
        { source: 'github', key: 'example-org/planning#7', ...ELSEWHERE },
      ],
      outcome: 'read',
      detail: '1 issue this pull request closes and 1 issue that references it',
    });
  });

  it('names itself GitHub, and says why when GitHub will not give the issues', async () => {
    const source = gitHubIssues(
      clientWith(async () => {
        throw Object.assign(new Error('boom'), { status: 403 });
      }),
    );

    expect(source.source).toBe('github');
    expect(await source.readLinkedIssues({ ref, base: 'master' })).toEqual({
      issues: [],
      outcome: 'unreadable',
      detail: 'the linked issues could not be read: GitHub answered 403',
    });
  });
});

describe('gitHubKey', () => {
  it('shows an issue of the pull request’s repository by its number alone, whatever the letter case GitHub names it in', () => {
    expect(gitHubKey(ref, { repository: 'Example-Org/Example-Repo', number: 30 })).toBe('#30');
    expect(gitHubKey(ref, { repository: 'example-org/planning', number: 7 })).toBe('example-org/planning#7');
  });
});

describe('withIssueSources', () => {
  it('reads criteria kept before issues named their source as GitHub’s, and keeps criteria that already name theirs', () => {
    const older = { outcome: 'read' as const, detail: '1 issue this pull request closes', heading: 'Acceptance criteria', issues: [OWN, ELSEWHERE], criteria: [] };
    const sourced = withIssueSources(older, ref);

    expect(sourced).toEqual({
      ...older,
      sources: [{ source: 'github', outcome: 'read', detail: '1 issue this pull request closes' }],
      issues: [
        { source: 'github', key: '#30', ...OWN },
        { source: 'github', key: 'example-org/planning#7', ...ELSEWHERE },
      ],
    });
    expect(withIssueSources(sourced, ref)).toEqual(sourced);
  });
});
