import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_MARKS, applyMark, markedPart, type Part, type ReviewedMarks, type ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import { MARK_REVIEWED_COMMAND, PART_BANNER_CONTEXT, PART_BANNER_CONTROLLER_ID } from '../src/commands.js';
import { BANNER_COMMANDS, PartBanner, bannerBody, isBannerPartRef } from '../src/part-banner.js';
import { mixedResult, part, result } from './results.js';
import { StubMarkdownString, stub, type StubCommentController } from './vscode-stub.js';

const NOW = new Date('2026-10-10T12:00:00Z');

function marked(...parts: Part[]): ReviewedMarks {
  return parts.reduce((marks, each) => applyMark(marks, markedPart(each), true, NOW), NO_MARKS);
}

/** Each command link of a body, with its text, its command and the arguments it carries. */
function links(body: string): { text: string; command: string; args: unknown[] }[] {
  return [...body.matchAll(/\[((?:\\.|[^\]\\])+)\]\(command:([^?]+)\?([^)]+)\)/g)].map(([, text, command, args]) => ({
    text: text!.replace(/\\(.)/g, '$1'),
    command: command!,
    args: JSON.parse(decodeURIComponent(args!)) as unknown[],
  }));
}

/** The banner's own controller, beside any other the companion made. */
function controller(): StubCommentController {
  return stub.commentControllers.find((each) => each.id === PART_BANNER_CONTROLLER_ID)!;
}

describe('the banner body', () => {
  const shown = mixedResult();
  const retry = shown.parts[0]!;
  const retryRef = { anchor: { path: 'src/retry.py', hunk: { oldStart: 3, newStart: 3 } } };

  it('gives the importance, the reading position and the reviewed checkbox, then the reason, the signals and the asks', () => {
    const body = bannerBody(shown, retry, NO_MARKS);

    expect(body.split('\n\n')).toEqual([
      `**Must review** · part 1 of 7 · ☐ [Mark reviewed](command:second-look.markReviewed?${encodeURIComponent(JSON.stringify([retryRef, true]))})`,
      'New code the send path now runs on every delivery\\.',
      'Signals: new code · 2 callers · no tests before this pull request · Plain ranking',
      expect.stringMatching(/^\[Explain this part\]/),
    ]);
  });

  it("runs, from every link, the command the part's context menu or its tree checkbox runs, carrying the part by where it starts", () => {
    expect(links(bannerBody(shown, retry, NO_MARKS))).toEqual([
      { text: 'Mark reviewed', command: 'second-look.markReviewed', args: [retryRef, true] },
      { text: 'Explain this part', command: 'second-look.ask.explain', args: [retryRef] },
      { text: 'Verify this claim', command: 'second-look.ask.verify', args: [retryRef] },
      { text: 'What covers this?', command: 'second-look.ask.cover', args: [retryRef] },
      { text: 'Why this matters', command: 'second-look.whyThisMatters', args: [retryRef] },
      { text: 'Comment on this part…', command: 'second-look.commentOnPart', args: [retryRef] },
    ]);
    expect(isBannerPartRef(retryRef)).toBe(true);
    expect(isBannerPartRef({ anchor: { path: 'src/settings.ts' } })).toBe(true);
    expect(isBannerPartRef(retry)).toBe(false);
    expect(isBannerPartRef({ anchor: { path: 'src/retry.py', hunk: { oldStart: '3' } } })).toBe(false);
  });

  it('ticks the checkbox of a reviewed part, with the link that clears its mark', () => {
    const body = bannerBody(shown, retry, marked(retry));

    expect(body.split('\n\n')[0]).toBe(
      `**Must review** · part 1 of 7 · ☑ Reviewed · [Clear the reviewed mark](command:second-look.markReviewed?${encodeURIComponent(JSON.stringify([retryRef, false]))})`,
    );
    expect(links(body)[0]).toEqual({ text: 'Clear the reviewed mark', command: 'second-look.markReviewed', args: [retryRef, false] });
  });

  it('says a part changed since the reviewer marked it, its checkbox empty again', () => {
    const [hunk] = retry.hunks;
    const edited: Part = { ...retry, hunks: [{ ...hunk!, lines: [...hunk!.lines, { kind: 'addition', newLineNumber: 14, text: 'edited' }] }] };
    const body = bannerBody({ ...shown, parts: [edited, ...shown.parts.slice(1)] }, edited, marked(retry));

    expect(body.split('\n\n')[0]).toMatch(/^\*\*Must review\*\* · part 1 of 7 · ☐ \[Mark reviewed\]\(.+\) — changed since you marked it$/);
  });

  it("gives a noise part its label and blind spot, and an unranked part only what it has, with every ask", () => {
    const lock = shown.parts[5]!;
    const legacy = shown.parts[3]!;

    const noise = bannerBody(shown, lock, NO_MARKS).split('\n\n');
    expect(noise[0]).toMatch(/^\*\*Noise\*\* · lockfile · claimed · part 6 of 7 · ☐ \[Mark reviewed\]/);
    expect(noise[1]).toBe('Only known lockfile names are matched\\.');
    expect(noise).toHaveLength(3);
    expect(links(noise[2]!).map((link) => link.command)).toEqual(BANNER_COMMANDS.slice(1));

    const unranked = bannerBody(shown, legacy, NO_MARKS).split('\n\n');
    expect(unranked[0]).toMatch(/^\*\*Not ranked yet\*\* · part 4 of 7 · ☐ \[Mark reviewed\]/);
    expect(unranked).toHaveLength(2);
  });

  it('names the agent ranking when it is the one shown', () => {
    const ranked: ReviewResult = {
      ...shown,
      ranking: {
        by: 'agent',
        agent: {
          outcome: 'ranked',
          detail: 'ranked every part',
          promptVersion: '2',
          stamp: { agent: 'pi', agentVersion: '0.86.1', model: 'zai/glm-4.6', effort: null, runAt: '2026-10-07T00:00:00.000Z' },
        },
      },
    } as ReviewResult;

    expect(bannerBody(ranked, retry, NO_MARKS).split('\n\n')[2]).toBe(
      'Signals: new code · 2 callers · no tests before this pull request · Agent ranking: pi · zai/glm\\-4\\.6 · default effort \\(ranking prompt v2\\)',
    );
  });

  it("escapes the reason and signals, which are the engine's and the agent's words, so they never render as markup", () => {
    const injected = part('src/a.py', {
      rank: { importance: 'worth reviewing', reason: 'See [this](command:workbench.action.terminal.new) <b>now</b>', signals: ['**bold**'] },
    });
    const body = bannerBody(result([injected]), injected, NO_MARKS);

    expect(body).toContain('See \\[this\\]\\(command:workbench\\.action\\.terminal\\.new\\) \\<b\\>now\\</b\\>');
    expect(body).toContain('Signals: \\*\\*bold\\*\\*');
    expect(links(body).map((link) => link.command)).toEqual(BANNER_COMMANDS);
  });
});

describe('PartBanner', () => {
  beforeEach(() => {
    stub.reset();
  });

  it("shows the banner as a read-only file comment on the part's first file, on its head side, running only its own commands", () => {
    const shown = mixedResult();
    new PartBanner().show(shown, shown.parts[0]!, NO_MARKS);

    expect(controller().label).toBe('Second Look part');
    const [thread] = controller().threads;
    expect(controller().threads).toHaveLength(1);
    expect(thread!.uri.toString()).toBe(changeUri('head', shown.copies.head.commit, 'src/retry.py').toString());
    expect(thread!.range).toBeUndefined();
    expect(thread!.canReply).toBe(false);
    expect(thread!.contextValue).toBe(PART_BANNER_CONTEXT);
    expect(thread!.collapsibleState).toBe(1);
    expect(thread!.label).toBe('src/retry.py');
    const body = thread!.comments[0]!.body as StubMarkdownString & { isTrusted?: unknown };
    expect(body.value).toBe(bannerBody(shown, shown.parts[0]!, NO_MARKS));
    expect(body.isTrusted).toEqual({
      enabledCommands: ['second-look.markReviewed', 'second-look.ask.explain', 'second-look.ask.verify', 'second-look.ask.cover', 'second-look.whyThisMatters', 'second-look.commentOnPart'],
    });
    expect(thread!.comments[0]!.author.name).toBe('Second Look');
  });

  it("puts a deleted file's banner on its base side", () => {
    const gone = part('src/old.py', { changeKind: 'deletion', rank: { importance: 'context', reason: 'Removed.', signals: [] } });
    const shown = result([gone]);
    new PartBanner().show(shown, gone, NO_MARKS);

    expect(controller().threads.map((thread) => thread.uri.toString())).toEqual([changeUri('base', shown.copies.base.commit, 'src/old.py').toString()]);
  });

  it("updates one part's banner in place, moves to the next part's file, and goes with clear and dispose", () => {
    const shown = mixedResult();
    const banner = new PartBanner();
    banner.show(shown, shown.parts[0]!, NO_MARKS);
    const first = controller().threads[0];

    banner.show(shown, shown.parts[0]!, marked(shown.parts[0]!));
    expect(controller().threads).toEqual([first]);
    expect((first!.comments[0]!.body as StubMarkdownString).value).toContain('☑ Reviewed');

    banner.show(shown, shown.parts[1]!, NO_MARKS);
    expect(controller().threads.map((thread) => thread.uri.toString())).toEqual([changeUri('head', shown.copies.head.commit, 'src/settings.ts').toString()]);

    banner.clear();
    expect(controller().threads).toEqual([]);
    banner.dispose();
    expect(stub.commentControllers.some((each) => each.id === PART_BANNER_CONTROLLER_ID)).toBe(false);
  });
});

describe('the banner in the manifest', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    contributes: { commands: { command: string }[]; menus: Record<string, { command: string; when: string }[]> };
  };

  it("declares the command its reviewed checkbox runs, and hides it from the Command Palette, since it needs the banner's part", () => {
    expect(manifest.contributes.commands.map((command) => command.command)).toContain(MARK_REVIEWED_COMMAND);
    expect(manifest.contributes.menus['commandPalette']).toContainEqual({ command: MARK_REVIEWED_COMMAND, when: 'false' });
  });
});
