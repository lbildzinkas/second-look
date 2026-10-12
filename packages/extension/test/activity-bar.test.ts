import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPANION_SETTINGS_QUERY,
  OPEN_COMPANION_SETTINGS_COMMAND,
  REFRESH_PULL_REQUESTS_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  REVIEWING_CONTEXT,
  STOP_REVIEW_COMMAND,
} from '../src/commands.js';
import { viewContainerIconFiles } from '../src/packaging.js';

interface Manifest {
  name: string;
  publisher: string;
  contributes: {
    configuration: { properties: Record<string, unknown> };
    commands: { command: string; icon?: string }[];
    menus: Record<string, { command: string; when: string; group?: string }[]>;
    viewsContainers: Record<string, { id: string; title: string; icon: string }[]>;
    views: Record<string, { type?: string; id: string; name: string }[]>;
    viewsWelcome?: unknown;
  };
}

const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as Manifest;

/**
 * Where each command, ask and setting the companion offers lives in the
 * side bar: the design's inventory (docs/ux/review-path.html, appendix),
 * as built. Every one of them stays registered, so the Command Palette
 * and keybindings keep working too.
 */
const SIDE_BAR_PLACES: Record<string, string> = {
  'second-look.reviewPullRequest': 'step 2: the list, its URL box and its Review buttons; the title bar',
  'second-look.reviewAgain': 'the progress strip: Review again, under the review shown',
  'second-look.openPart': 'step 4: each part row',
  'second-look.openAllParts': 'step 4: All in order; step 7: Open the threads in the diff; the title bar',
  'second-look.filterChangedSinceLastLook': 'step 4: Changed since last look, on a second visit; the title bar',
  'second-look.submitReview': 'step 8: Open the Send review page; the title bar',
  'second-look.addComment': "the editor gutter's +, as step 7 says",
  'second-look.commentOnPart': "a part row's ⋯ menu, as step 7 says",
  'second-look.discardComment': "step 7: a comment's Discard",
  'second-look.openOverview': 'steps 3, 5 and 6: Open the overview; the title bar',
  'second-look.whyThisMatters': "a part row's ⋯ menu",
  'second-look.fetchLibrary': "step 5: a finding's Fetch library or Decompile",
  'second-look.openLibraryEvidence': "step 5: a finding's Open",
  'second-look.draftComment': "steps 5 and 6: a finding's Draft comment",
  'second-look.addDraft': "step 7: a draft's Add to review",
  'second-look.discardDraft': "step 7: a draft's Discard draft",
  'second-look.ask.explain': "a part row's Ask…",
  'second-look.ask.verify': "a part row's Ask…; step 5: Verify again and Verify a claim…",
  'second-look.ask.cover': "a part row's Ask…",
  'second-look.markReviewed': "step 4: each part row's checkbox",
  'second-look.chooseAgent': "step 1's form; the status bar",
  'second-look.openSetup': "step 1's change link",
  'second-look.refreshPullRequests': 'the title bar',
  'second-look.stopReview': 'the title bar, while a review runs',
  'second-look.openSettings': "the title bar's ⋯ menu",
  'second-look.agent': "step 1's form",
  'second-look.agentModel': "step 1's form",
  'second-look.agentEffort': "step 1's form",
  'second-look.agentAccount': "step 1's form: the account label",
  'second-look.claudeCodePath': "step 1's form: the agent path",
  'second-look.piPath': "step 1's form: the agent path",
  'second-look.mirrorViewedToGitHub': "step 4's ⋯ menu",
  'second-look.criteriaHeading': "step 6's ⋯",
  'second-look.budget.agentRuns': "the title bar's ⋯ menu: Open Second Look settings",
  'second-look.budget.filesFetched': "the title bar's ⋯ menu: Open Second Look settings",
  'second-look.budget.downloadMiB': "the title bar's ⋯ menu: Open Second Look settings",
};

describe('the side bar in the Activity Bar', () => {
  it('lives in its own Second Look container, and nowhere in the Explorer', () => {
    const { viewsContainers, views } = MANIFEST.contributes;
    expect(viewsContainers['activitybar']).toEqual([
      { id: 'second-look', title: 'Second Look', icon: 'media/second-look.svg' },
    ]);
    expect(views['second-look']).toEqual([{ type: 'webview', id: REVIEW_TREE_VIEW, name: 'Second Look' }]);
    expect(views['explorer']).toBeUndefined();
  });

  it("draws the container's icon at 24 × 24 in the theme's own colour", () => {
    expect(viewContainerIconFiles(MANIFEST as unknown as Record<string, unknown>)).toEqual(['media/second-look.svg']);
    const svg = readFileSync(fileURLToPath(new URL('../media/second-look.svg', import.meta.url)), 'utf8');
    expect(svg).toMatch(/<svg [^>]*width="24" height="24" viewBox="0 0 24 24"/);
    expect(svg).toContain('stroke="currentColor"');
    // Monochrome: currentColor is the only colour it names.
    expect(svg.match(/(?:fill|stroke)="(?!none|currentColor)[^"]*"/g)).toBeNull();
  });

  it("starts a review from the title bar, with no Command Palette; step 2's card carries the button, so the view needs no welcome content", () => {
    const { commands, menus, viewsWelcome } = MANIFEST.contributes;
    expect(viewsWelcome).toBeUndefined();
    expect(menus['view/title']).toContainEqual({
      command: REVIEW_COMMAND,
      when: `view == ${REVIEW_TREE_VIEW}`,
      group: 'navigation',
    });
    expect(commands.find((command) => command.command === REVIEW_COMMAND)?.icon).toBe('$(git-pull-request)');
  });

  it("reloads step 2's list of pull requests from a refresh button in the title bar", () => {
    const { commands, menus } = MANIFEST.contributes;
    expect(menus['view/title']![0]).toEqual({ command: REFRESH_PULL_REQUESTS_COMMAND, when: `view == ${REVIEW_TREE_VIEW}`, group: 'navigation' });
    expect(commands.find((command) => command.command === REFRESH_PULL_REQUESTS_COMMAND)?.icon).toBe('$(refresh)');
  });

  it('stops a running review from a Stop review button in the title bar, shown only while one runs', () => {
    const { commands, menus } = MANIFEST.contributes;
    expect(menus['view/title']).toContainEqual({ command: STOP_REVIEW_COMMAND, when: `view == ${REVIEW_TREE_VIEW} && ${REVIEWING_CONTEXT}`, group: 'navigation' });
    expect(menus['commandPalette']).toContainEqual({ command: STOP_REVIEW_COMMAND, when: REVIEWING_CONTEXT });
    expect(commands.find((command) => command.command === STOP_REVIEW_COMMAND)).toMatchObject({ title: 'Stop review', icon: '$(debug-stop)' });
  });

  it("opens every one of the companion's settings from the title bar's ⋯ menu", () => {
    const { commands, menus } = MANIFEST.contributes;
    expect(commands.find((command) => command.command === OPEN_COMPANION_SETTINGS_COMMAND)).toMatchObject({ title: 'Open Second Look settings' });
    // Out of the navigation group, so it sits in the ⋯ menu rather than among the buttons.
    expect(menus['view/title']).toContainEqual({ command: OPEN_COMPANION_SETTINGS_COMMAND, when: `view == ${REVIEW_TREE_VIEW}`, group: 'settings' });
    expect(COMPANION_SETTINGS_QUERY).toBe(`@ext:${MANIFEST.publisher}.${MANIFEST.name}`);
  });

  it('gives every command, ask and setting the companion offers a place in the side bar', () => {
    const { commands, configuration } = MANIFEST.contributes;
    const offered = [...commands.map((command) => command.command), ...Object.keys(configuration.properties)].sort();
    expect(Object.keys(SIDE_BAR_PLACES).sort()).toEqual(offered);
  });
});
