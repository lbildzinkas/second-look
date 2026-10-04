import * as vscode from 'vscode';
import { findingAnchor, isFinding, type Claim, type ReviewResult } from '@second-look/engine';
import { changeUri, partFiles } from './change-copies.js';
import { FETCH_LIBRARY_COMMAND, FINDINGS_CONTROLLER_ID, FINDING_THREAD_CONTEXT, OPEN_LIBRARY_EVIDENCE_COMMAND } from './commands.js';
import { citedWhere, claimWhere } from './overview.js';

/** Markdown's punctuation, escaped, so text someone else wrote renders exactly as written. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, (character) => `\\${character}`);
}

/** A verdict kind as a thread's label reads it, such as `Refuted`. */
function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** A command link the finding's trusted Markdown runs, with its arguments. */
function commandLink(text: string, command: string, args: readonly unknown[]): string {
  return `[${escapeMarkdown(text)}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

/**
 * A finding's thread body, as Markdown in which only the companion's own
 * words are markup: the verdict with its evidence source, the claim's
 * quote, the reason, each citation the engine re-checked — a CI log's
 * line labelled as one — the library
 * the claim needs when it needs one — with the library fetch the
 * companion offers for it, a link the reviewer presses, or the library
 * source the verdict was judged against, each cited file a link that
 * opens it read-only — why the engine dropped the verdict when it did,
 * and where the claim is made. Every quote, reason, name and path came
 * from the pull request, the agent or the package index, so each is
 * escaped; `index` is the claim's index in the result's claims, which the
 * links carry.
 */
export function findingBody(claim: Claim, index = 0): string {
  const { verdict } = claim;
  if (verdict.kind === 'not checked') return '';
  const { libraryFetch: offer, library } = verdict;
  const lines = [
    `**${kindLabel(verdict.kind)}** · evidence source: ${escapeMarkdown(verdict.source)}`,
    '',
    `> ${escapeMarkdown(claim.quote)}`,
    '',
    escapeMarkdown(verdict.reason),
  ];
  if (verdict.evidence.length > 0) {
    const where = (cited: (typeof verdict.evidence)[number], at: number): string =>
      library === undefined ? escapeMarkdown(citedWhere(cited)) : commandLink(`${cited.path}:${cited.line}`, OPEN_LIBRARY_EVIDENCE_COMMAND, [index, at]);
    lines.push('', 'Evidence:', ...verdict.evidence.map((cited, at) => `- ${where(cited, at)} — ${escapeMarkdown(cited.quote)}`));
  }
  if (library !== undefined) {
    lines.push(
      '',
      `Judged against the source of ${escapeMarkdown(`${library.library} ${library.pinnedVersion}`)}, as ${escapeMarkdown(library.pinnedBy)} pins it: ` +
        `${escapeMarkdown(library.file)}, its SHA-256 checked, unpacked read-only and never run.`,
    );
    if (library.note !== undefined) lines.push('', escapeMarkdown(library.note));
  } else if (offer !== undefined) {
    const name = `${offer.library} ${offer.pinnedVersion}`;
    lines.push('', escapeMarkdown(offer.reason), '', `${commandLink(`Fetch ${name}`, FETCH_LIBRARY_COMMAND, [index])} — downloads only when pressed.`);
  } else if (verdict.needsLibrary !== undefined) {
    lines.push('', `Needs the source of ${escapeMarkdown(verdict.needsLibrary)}, which the companion does not have.`);
  }
  if (verdict.recheck !== undefined) lines.push('', `Dropped to unverifiable: ${escapeMarkdown(verdict.recheck)}.`);
  lines.push('', `Claim made in ${escapeMarkdown(claimWhere(claim))}.`);
  return lines.join('\n');
}

/**
 * The findings of a review — its refuted and unverifiable claims — shown
 * as the companion's own comment threads on the diff, beside the GitHub
 * extension's: each on the head-side line the claim is made on, else the
 * first line its verdict cites, else on its part as a whole. The threads
 * are read-only: the reviewer comments through the pending review, and
 * nothing here reaches GitHub.
 */
export class FindingThreads implements vscode.Disposable {
  private readonly controller: vscode.CommentController;

  private threads: vscode.CommentThread[] = [];

  constructor() {
    this.controller = vscode.comments.createCommentController(FINDINGS_CONTROLLER_ID, 'Second Look findings');
  }

  /** Shows a result's findings, replacing those of any earlier result. */
  show(result: ReviewResult): void {
    this.clear();
    for (const [index, claim] of (result.claims?.claims ?? []).entries()) {
      if (!isFinding(claim)) continue;
      const thread = this.threadFor(result, claim);
      if (thread === undefined) continue;
      const body = new vscode.MarkdownString(findingBody(claim, index));
      // Only the companion's own links run, and only these two commands.
      body.isTrusted = { enabledCommands: [FETCH_LIBRARY_COMMAND, OPEN_LIBRARY_EVIDENCE_COMMAND] };
      thread.comments = [
        {
          body,
          mode: vscode.CommentMode.Preview,
          author: { name: 'Second Look' },
          label: claim.verdict.kind,
        },
      ];
      thread.label = `${kindLabel(claim.verdict.kind)} claim`;
      thread.canReply = false;
      thread.contextValue = FINDING_THREAD_CONTEXT;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.threads.push(thread);
    }
  }

  /** A thread at the finding's line, or on its part's first file at no line. */
  private threadFor(result: ReviewResult, claim: Claim): vscode.CommentThread | undefined {
    const anchor = findingAnchor(claim, result.parts);
    if (anchor !== undefined) {
      const line = anchor.line - 1;
      return this.controller.createCommentThread(changeUri('head', result.copies.head.commit, anchor.path), new vscode.Range(line, 0, line, 0), []);
    }
    const part = result.parts[claim.part];
    const [file] = part === undefined ? [] : partFiles(result.copies, part);
    if (part === undefined || file === undefined) return undefined;
    // A thread at no line is the editor's own file comment; it is created
    // over a line first, then let loose of it.
    const thread = this.controller.createCommentThread(part.changeKind === 'deletion' ? file.original : file.modified, new vscode.Range(0, 0, 0, 0), []);
    thread.range = undefined;
    return thread;
  }

  /** Removes every finding thread. */
  clear(): void {
    for (const thread of this.threads) thread.dispose();
    this.threads = [];
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}
