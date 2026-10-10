import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASK_KINDS, ASKS } from '@second-look/engine';
import { askCommand } from '../src/commands.js';

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when: string; group?: string }[]>;
  };
}

const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as Manifest;

describe('the asks in the manifest', () => {
  it("declares one command for each ask in the engine's registry, titled as the registry names it", () => {
    const declared = MANIFEST.contributes.commands.filter((command) => command.command.startsWith('second-look.ask.'));
    expect(declared).toEqual(ASK_KINDS.map((kind) => ({ command: askCommand(kind), title: ASKS[kind].title, category: 'Second Look' })));
    expect(askCommand('explain')).toBe('second-look.ask.explain');
  });

  it("offers each ask in a part row's context menu in the side bar, and hides it from the Command Palette", () => {
    const { menus } = MANIFEST.contributes;
    for (const kind of ASK_KINDS) {
      const entries = menus['webview/context']!.filter((entry) => entry.command === askCommand(kind));
      expect(entries.map((entry) => entry.when)).toEqual(["webviewId == 'second-look.reviewTree' && webviewSection == 'part'"]);
      expect(menus['commandPalette']).toContainEqual({ command: askCommand(kind), when: 'false' });
    }
  });
});
