import * as vscode from 'vscode';
import { findingAnchor, isFinding, isUnprovenSource, type Claim, type FetchedLibrary, type LibraryArchive, type ReviewResult } from '@second-look/engine';
import { changeUri, partFiles } from './change-copies.js';
import { DRAFT_COMMENT_COMMAND, FETCH_LIBRARY_COMMAND, FINDINGS_CONTROLLER_ID, FINDING_THREAD_CONTEXT, OPEN_LIBRARY_EVIDENCE_COMMAND } from './commands.js';
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

/** How each pinned archive was checked and kept, in the companion's own words. */
const HOW_FETCHED: Record<Exclude<LibraryArchive, 'named repository' | 'decompiled NuGet package'>, string> = {
  wheel: ', its SHA-256 checked, unpacked read-only and never run.',
  'source archive': ', its SHA-256 checked, unpacked read-only and never run.',
  'NuGet package': ', its SHA-512 checked and never built or run, its source files fetched read-only at the commit it was built from.',
  'npm package': ', its SHA-512 checked, unpacked read-only and never run.',
  crate: ', its SHA-256 checked, unpacked read-only and never built or run.',
  'Go module': ', its go.sum hash checked, unpacked read-only and never built or run.',
  'sources jar': ", its SHA-1 checked against Maven Central's record, unpacked read-only and never built or run.",
};

/** How a cited file of a fetched library is labelled: decompiled, unproven, or not at all for exact source. */
function citationLabel(path: string, library: FetchedLibrary): string {
  if (library.archive === 'decompiled NuGet package') return ' (decompiled)';
  return isUnprovenSource(path, library.unproven) ? ' (unproven)' : '';
}

/**
 * A finding's thread body, as Markdown in which only the companion's own
 * words are markup: the verdict with its evidence source, the claim's
 * quote, the reason, each citation the engine re-checked — a CI log's
 * line labelled as one — the library
 * the claim needs when it needs one — with the library fetch the
 * companion offers for it, a link the reviewer presses, or the library
 * source the verdict was judged against, each cited file a link that
 * opens it read-only and labelled when it is unproven or decompiled — why the engine dropped the verdict when it did,
 * where the claim is made, that the Verify this claim ask judged it
 * alone when it did, and the link that drafts a comment from the
 * finding. Every quote, reason, name and path came
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
      library === undefined
        ? escapeMarkdown(citedWhere(cited))
        : commandLink(`${cited.path}:${cited.line}`, OPEN_LIBRARY_EVIDENCE_COMMAND, [index, at]) + citationLabel(cited.path, library);
    lines.push('', 'Evidence:', ...verdict.evidence.map((cited, at) => `- ${where(cited, at)} — ${escapeMarkdown(cited.quote)}`));
  }
  if (library !== undefined) {
    lines.push(
      '',
      library.archive === 'named repository'
        ? `Judged against ${escapeMarkdown(library.library)} in ${escapeMarkdown(library.pinnedBy)} at tag ${escapeMarkdown(library.pinnedVersion)}, which the agent named: ` +
            `a named repository, weaker evidence than pinned source, since nothing pins it. ${escapeMarkdown(library.file)} was unpacked read-only and never run.`
        : library.archive === 'decompiled NuGet package'
          ? `Judged against code decompiled from ${escapeMarkdown(`${library.library} ${library.pinnedVersion}`)}, as ${escapeMarkdown(library.pinnedBy)} pins it: ` +
              `decompiled, not its source. ${escapeMarkdown(library.file)} had its SHA-512 checked and was decompiled read-only with no network, never built or run.`
          : `Judged against the source of ${escapeMarkdown(`${library.library} ${library.pinnedVersion}`)}, as ${escapeMarkdown(library.pinnedBy)} pins it: ` +
            escapeMarkdown(library.file) +
            HOW_FETCHED[library.archive],
    );
    if (library.note !== undefined) lines.push('', escapeMarkdown(library.note));
    if (library.unproven !== undefined) lines.push('', `Unproven, so never verified: ${library.unproven.map(escapeMarkdown).join(', ')}.`);
  } else if (offer !== undefined) {
    const name = offer.namedRepository === undefined ? `${offer.library} ${offer.pinnedVersion}` : `${offer.namedRepository.url} at tag ${offer.namedRepository.tag}`;
    const press =
      offer.decompile === undefined
        ? `${commandLink(`Fetch ${name}`, FETCH_LIBRARY_COMMAND, [index])} — downloads only when pressed.`
        : `${commandLink(`Decompile ${name}`, FETCH_LIBRARY_COMMAND, [index])} — decompiles only when pressed, with the decompiler you installed.`;
    lines.push('', escapeMarkdown(offer.reason), '', press);
  } else if (verdict.needsLibrary !== undefined) {
    lines.push('', `Needs the source of ${escapeMarkdown(verdict.needsLibrary)}, which the companion does not have.`);
    if (verdict.noLibraryFetch !== undefined) lines.push('', escapeMarkdown(verdict.noLibraryFetch));
  }
  if (verdict.recheck !== undefined) lines.push('', `Dropped to unverifiable: ${escapeMarkdown(verdict.recheck)}.`);
  if (claim.asked === true) lines.push('', 'Judged singly by the **Verify this claim** ask.');
  lines.push('', `Claim made in ${escapeMarkdown(claimWhere(claim))}.`);
  lines.push('', `${commandLink('Draft comment', DRAFT_COMMENT_COMMAND, [{ kind: 'claim', index }])} — you edit the draft, then add it to the pending review or discard it.`);
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
      // Only the companion's own links run, and only these three commands.
      body.isTrusted = { enabledCommands: [FETCH_LIBRARY_COMMAND, OPEN_LIBRARY_EVIDENCE_COMMAND, DRAFT_COMMENT_COMMAND] };
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
