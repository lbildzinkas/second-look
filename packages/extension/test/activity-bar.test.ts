import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REVIEW_COMMAND, REVIEW_TREE_VIEW } from '../src/commands.js';
import { viewContainerIconFiles } from '../src/packaging.js';

interface Manifest {
  contributes: {
    commands: { command: string; icon?: string }[];
    menus: Record<string, { command: string; when: string; group?: string }[]>;
    viewsContainers: Record<string, { id: string; title: string; icon: string }[]>;
    views: Record<string, { id: string; name: string }[]>;
    viewsWelcome: { view: string; contents: string }[];
  };
}

const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as Manifest;

describe('the review tree in the Activity Bar', () => {
  it('lives in its own Second Look container, and nowhere in the Explorer', () => {
    const { viewsContainers, views } = MANIFEST.contributes;
    expect(viewsContainers['activitybar']).toEqual([
      { id: 'second-look', title: 'Second Look', icon: 'media/second-look.svg' },
    ]);
    expect(views['second-look']).toEqual([{ id: REVIEW_TREE_VIEW, name: 'Second Look' }]);
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

  it('starts a review from the empty view and from the title bar, with no Command Palette', () => {
    const { commands, menus, viewsWelcome } = MANIFEST.contributes;
    expect(viewsWelcome).toEqual([
      {
        view: REVIEW_TREE_VIEW,
        contents: `Review a pull request to see its parts here, ranked by importance.\n[Review a pull request](command:${REVIEW_COMMAND})`,
      },
    ]);
    expect(menus['view/title']).toContainEqual({
      command: REVIEW_COMMAND,
      when: `view == ${REVIEW_TREE_VIEW}`,
      group: 'navigation',
    });
    expect(commands.find((command) => command.command === REVIEW_COMMAND)?.icon).toBe('$(git-pull-request)');
  });
});
