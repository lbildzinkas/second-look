import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOAD_PROJECT_COMMAND } from '../src/commands.js';
import { loadProjectWarning } from '../src/project-load.js';
import { mixedResult } from './results.js';

interface Manifest {
  contributes: {
    commands: { command: string; title: string; category: string }[];
    menus: Record<string, { command: string; when: string; group?: string }[]>;
  };
}

const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as Manifest;

describe('the warning before the project is loaded for navigation', () => {
  it('names what can run: the restore, build targets, analyzers and interpreters', () => {
    const { message, detail } = loadProjectWarning(mixedResult(), true);

    expect(message).toBe(`Load the project of #${mixedResult().pullRequest.number} for navigation?`);
    for (const named of ['restoring the project', 'build targets', 'analyzers', 'interpreters']) {
      expect(detail).toContain(named);
    }
    expect(detail).toContain('runs as you');
  });

  it('says what is written and where it opens, and that nothing happens without the confirmation', () => {
    const { detail } = loadProjectWarning(mixedResult(), true);

    expect(detail).toContain(`writable copy of the head commit ${mixedResult().copies.head.commit.slice(0, 7)}`);
    expect(detail).toContain('in a new window');
    expect(detail).toContain('Nothing is written or opened unless you confirm.');
  });

  it("says the folder opens untrusted unless the reviewer trusts it, and the agents' posture is unchanged", () => {
    const { detail } = loadProjectWarning(mixedResult(), true);

    expect(detail).toContain('The folder opens untrusted, in Restricted Mode, unless you trust it');
    expect(detail).toContain("The companion's agents keep their locked-down posture: they read only the read-only copies, never this folder.");
  });

  it('says the folder opens trusted when workspace trust is turned off', () => {
    const { detail } = loadProjectWarning(mixedResult(), false);

    expect(detail).toContain('Workspace trust is turned off (security.workspace.trust.enabled), so the folder opens trusted');
    expect(detail).not.toContain('opens untrusted');
  });
});

describe('the load command in the manifest', () => {
  it('is declared, and offered in the review tree title bar menu', () => {
    expect(MANIFEST.contributes.commands).toContainEqual({ command: LOAD_PROJECT_COMMAND, title: 'Load the project for navigation…', category: 'Second Look' });
    expect(MANIFEST.contributes.menus['view/title']).toContainEqual({ command: LOAD_PROJECT_COMMAND, when: 'view == second-look.reviewTree', group: 'project' });
  });
});
