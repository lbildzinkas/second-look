import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { draftFinding, type FindingRef, type ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import { COMMENT_CONTROLLER_ID, DRAFT_COMMENT_COMMAND, REVIEW_COMMAND } from '../src/commands.js';
import { activate } from '../src/extension.js';
import { escapeMarkdown } from '../src/findings.js';
import { OVERVIEW_VIEW_TYPE } from '../src/overview.js';
import { PageDouble } from './overview-page.js';
import { judgedResult, mappedCriteriaResult, unexplainedResult } from './results.js';
import { ProgressLocation, stub, stubContext, TextEditorRevealType, type StubCommentThread } from './vscode-stub.js';

/**
 * Draft comment pressed where the reviewer meets a finding — a row of the
 * side bar's steps 5 and 6, the overview's claims and criteria, the
 * finding's thread — driven end to end: the message each page's script
 * posts, the provider or panel that reads it, the draft command, and a fake
 * engine process that speaks the engine's real stdio protocol. The draft
 * opens where the reviewer sees it, and the drafting shows while it runs.
 */

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
const TOKEN = 'ghp_test-token-do-not-print';
const workDir = mkdtempSync(join(tmpdir(), 'second-look-draft-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** The judged review with the description's claim refuted, the row the reviewer pressed, and step 6's findings. */
function reviewed(): ReviewResult {
  const shown = judgedResult();
  const [description, ...rest] = shown.claims!.claims;
  return {
    ...shown,
    claims: {
      ...shown.claims!,
      claims: [
        { ...description!, verdict: { kind: 'refuted', source: 'the change itself', reason: 'The loop runs five times.', evidence: [{ path: 'src/retry.py', line: 6, quote: 'for attempt in range(5):' }] } },
        ...rest,
      ],
    },
    criteria: mappedCriteriaResult().criteria,
    unexplained: unexplainedResult().unexplained,
  };
}

/** The draft the engine answers for a finding of the review. */
function draftOf(result: ReviewResult, finding: FindingRef, body: string) {
  return {
    finding,
    statement: draftFinding(result, finding)!.statement,
    body,
    promptVersion: '1',
    stamp: { agent: 'claude-code', agentVersion: '2.1.0', model: 'claude-sonnet-5-5', effort: 'high', runAt: '2026-10-12T00:00:00.000Z' },
  };
}

/** Starts the extension against a fake engine that answers the review, and a draft or a draft's failure. */
async function reviewWith(result: ReviewResult, answer: { draft: unknown } | { error: string }, logName: string): Promise<void> {
  activate(stubContext() as never, {
    spawnEngine: (): ChildProcessWithoutNullStreams =>
      spawn(process.execPath, [FAKE_ENGINE], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FAKE_ENGINE_RESULT: JSON.stringify(result),
          ...('draft' in answer ? { FAKE_ENGINE_DRAFT_RESULT: JSON.stringify(answer.draft) } : { FAKE_ENGINE_DRAFT_ERROR: answer.error }),
          FAKE_ENGINE_LOG: join(workDir, logName),
        },
      }),
  });
  stub.inputBoxResult = PR_URL;
  stub.session = { accessToken: TOKEN };
  await stub.commands.find((command) => command.id === REVIEW_COMMAND)!.handler();
}

/** Delivers a message a page's script posts, and waits for every command it runs to settle. */
async function post(receive: (message: unknown) => void, message: unknown): Promise<void> {
  const before = stub.commandRuns.length;
  receive(message);
  await Promise.all(stub.commandRuns.slice(before));
}

/** A press in the side bar, as its page's script reports it. */
function sideBar(message: unknown): Promise<void> {
  const entry = stub.webviewViewProviders[0]!;
  const page = entry.views.at(-1) ?? entry.resolve();
  return post((each) => page.webview.receive(each), message);
}

/** A Draft comment button pressed in the overview: the page's own script posts the finding, which the panel reads. */
function overview(finding: FindingRef): void {
  const panel = stub.webviewPanels.find((each) => each.viewType === OVERVIEW_VIEW_TYPE)!;
  const page = PageDouble.load(panel.webview.html);
  const button = page.matching('button.draft').find((each) => each.getAttribute('data-draft') === finding.kind && each.getAttribute('data-index') === String(finding.index));
  expect(button, `${finding.kind} ${finding.index}`).toBeDefined();
  button!.click();
  expect(page.posted).toEqual([{ type: 'draft', finding: finding.kind, index: finding.index }]);
  panel.webview.receive(page.posted[0]);
}

/** Waits for what a press finishes on its own: the overview runs its draft without the command registry, so nothing settles it. */
async function until(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The draft's last steps after the thread appears: opening its line.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** The draft threads the review's comments show. */
function draftThreads(): StubCommentThread[] {
  const comments = stub.commentControllers.find((controller) => controller.id === COMMENT_CONTROLLER_ID)!;
  return comments.threads.filter((thread) => thread.comments[0]?.contextValue === 'second-look-draft');
}

/** The editors opened since the press: each URI with the line its selection starts on. */
function opened(): { uri: string; line: number | undefined }[] {
  return stub.executedCommands
    .filter((command) => command.id === 'vscode.open')
    .map((command) => ({ uri: String(command.args[0]), line: (command.args[1] as { selection?: { start: { line: number } } } | undefined)?.selection?.start.line }));
}

/** The draft requests that reached the engine, as the fake engine logged them. */
function drafted(logName: string): unknown[] {
  return readFileSync(join(workDir, logName), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { method?: string; params?: { finding?: unknown } })
    .filter((request) => request.method === 'draftComment')
    .map((request) => request.params?.finding);
}

const head = (path: string) => changeUri('head', judgedResult().copies.head.commit, path).toString();

describe('Draft comment, pressed where a finding is offered', () => {
  beforeEach(() => stub.reset());

  it("drafts from a refuted claim's row in step 5, saying so while it runs, and opens the draft at its line", async () => {
    const result = reviewed();
    const finding = { kind: 'claim', index: 0 } as const;
    await reviewWith(result, { draft: draftOf(result, finding, 'The description says three attempts; the loop runs five.') }, 'step-5.log');
    stub.executedCommands = [];

    await sideBar({ type: 'finding', action: 'draft', kind: 'claim', index: 0 });

    expect(drafted('step-5.log')).toEqual([finding]);
    // The drafting shows wherever the reviewer is looking, not only on the side bar's own view.
    expect(stub.progress.at(-1)).toEqual({ title: 'Drafting a comment from the refuted claim…', location: ProgressLocation.Notification });
    // The draft's thread sits on the line its evidence cites, and that line opens with it.
    const [thread] = draftThreads();
    expect(thread?.uri.toString()).toBe(head('src/retry.py'));
    expect(thread?.range?.start.line).toBe(5);
    expect(thread?.comments[0]?.body).toBe(escapeMarkdown('The description says three attempts; the loop runs five.'));
    expect(opened()).toEqual([{ uri: head('src/retry.py'), line: 5 }]);
    expect([...stub.errorMessages, ...stub.warningMessages]).toEqual([]);
  });

  it("drafts from the overview's claims and from the finding's thread link, showing the draft each time", async () => {
    const result = reviewed();
    const finding = { kind: 'claim', index: 1 } as const;
    await reviewWith(result, { draft: draftOf(result, finding, 'The docstring says three attempts.') }, 'overview-claim.log');
    stub.executedCommands = [];

    overview(finding);
    await until('the draft', () => draftThreads().length === 1);
    expect(opened()).toEqual([{ uri: head('src/retry.py'), line: 2 }]);

    // The thread's link runs the same command with the same finding, pressed in the diff that shows the file:
    // the draft is scrolled to there, with no second editor opened.
    const revealed: unknown[] = [];
    stub.visibleTextEditors = [{ document: { uri: head('src/retry.py') }, revealRange: (range: { start: { line: number } }, type: number) => revealed.push([range.start.line, type]) }];
    stub.executedCommands = [];
    await stub.commands.find((command) => command.id === DRAFT_COMMENT_COMMAND)!.handler({ kind: 'claim', index: 1 });
    expect(opened()).toEqual([]);
    expect(revealed).toEqual([[2, TextEditorRevealType.InCenterIfOutsideViewport]]);

    expect(drafted('overview-claim.log')).toEqual([finding, finding]);
    expect(draftThreads()).toHaveLength(2);
    expect([...stub.errorMessages, ...stub.warningMessages]).toEqual([]);
  });

  it("drafts from step 6's unexplained part, opening the draft on its part", async () => {
    const result = reviewed();
    const finding = { kind: 'unexplained part', index: 0 } as const;
    await reviewWith(result, { draft: draftOf(result, finding, 'Why does the timeout change here?') }, 'step-6-part.log');
    stub.executedCommands = [];

    await sideBar({ type: 'finding', action: 'draft', kind: 'unexplained part', index: 0 });

    const [thread] = draftThreads();
    expect(thread?.range).toBeUndefined();
    expect(opened()).toEqual([{ uri: thread!.uri.toString(), line: 0 }]);
    expect(stub.progress.at(-1)).toEqual({ title: `Drafting a comment from the ${draftFinding(result, finding)!.kind}…`, location: ProgressLocation.Notification });
  });

  it("drafts from a criterion in step 6 and in the overview's criteria, opening the draft for editing", async () => {
    const result = reviewed();
    const finding = { kind: 'criterion', index: 1 } as const;
    await reviewWith(result, { draft: draftOf(result, finding, 'The criterion asks for a log line on each retry.') }, 'criterion.log');
    // The reviewer escapes each box: the draft is discarded.
    stub.inputBoxResult = undefined;
    stub.inputBoxes = [];

    await sideBar({ type: 'finding', action: 'draft', kind: 'criterion', index: 1 });
    overview(finding);
    await until('the second box', () => stub.inputBoxes.length === 2);

    expect(drafted('criterion.log')).toEqual([finding, finding]);
    const box = { title: `Draft comment from the ${draftFinding(result, finding)!.kind}`, value: escapeMarkdown('The criterion asks for a log line on each retry.') };
    expect(stub.inputBoxes).toEqual([box, box]);
    const drafting = stub.progress.filter((each) => each.title.startsWith('Drafting'));
    expect(drafting.map((each) => each.location)).toEqual([ProgressLocation.Notification, ProgressLocation.Notification]);
  });

  it('says plainly why a draft could not be made', async () => {
    await reviewWith(reviewed(), { error: 'claude-code exited with code 1: not signed in' }, 'failed.log');

    await sideBar({ type: 'finding', action: 'draft', kind: 'claim', index: 0 });

    expect(stub.errorMessages).toEqual(['Could not draft a comment from the refuted claim: claude-code exited with code 1: not signed in']);
    expect(draftThreads()).toEqual([]);
  });
});
