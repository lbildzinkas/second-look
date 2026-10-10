import * as vscode from 'vscode';
import {
  ASK_KINDS,
  ASKS,
  isLabelledNoise,
  noiseSinks,
  reviewedState,
  type Part,
  type ReviewedMarks,
  type ReviewResult,
} from '@second-look/engine';
import { partFiles } from './change-copies.js';
import {
  COMMENT_ON_PART_COMMAND,
  MARK_REVIEWED_COMMAND,
  PART_BANNER_CONTEXT,
  PART_BANNER_CONTROLLER_ID,
  WHY_THIS_MATTERS_COMMAND,
  askCommand,
} from './commands.js';
import { commandLink, escapeMarkdown } from './findings.js';
import { CHANGED_SINCE_MARKED, SECTION_TITLES, anchorOf, partsInReadingOrder, rankingLine, type PartAnchor } from './tree.js';

/**
 * What the banner's links carry to the commands they run: the part, by
 * where it starts, which the session finds again in the result it shows.
 */
export interface BannerPartRef {
  anchor: PartAnchor;
}

/** Whether a command's argument is a banner's reference to a part. */
export function isBannerPartRef(value: unknown): value is BannerPartRef {
  if (typeof value !== 'object' || value === null) return false;
  const anchor = (value as { anchor?: unknown }).anchor;
  if (typeof anchor !== 'object' || anchor === null || typeof (anchor as PartAnchor).path !== 'string') return false;
  const hunk = (anchor as PartAnchor).hunk;
  return hunk === undefined || (typeof hunk === 'object' && hunk !== null && typeof hunk.oldStart === 'number' && typeof hunk.newStart === 'number');
}

/**
 * The only commands the banner's links run: the ones the part's context
 * menu offers, and the one its checkbox in the tree runs through.
 */
export const BANNER_COMMANDS: readonly string[] = [
  MARK_REVIEWED_COMMAND,
  ...ASK_KINDS.map(askCommand),
  WHY_THIS_MATTERS_COMMAND,
  COMMENT_ON_PART_COMMAND,
];

/**
 * The banner's body, as Markdown in which only the companion's own words
 * are markup, in the order the reviewing surface gives it: the part's
 * importance — or its noise label, or that it is not ranked yet — where
 * it sits in the tree's reading order, and its reviewed checkbox; then
 * the importance's one-line reason, or the noise label's blind spot; the
 * signals the reason cites, with which ranking is shown; and the asks,
 * with the rest of what the part's context menu offers. Every link runs
 * the same command the context menu or the tree checkbox does, carrying
 * the part by where it starts. The reason, the signals and the labels
 * came from the engine and the agent, so each is escaped.
 */
export function bannerBody(result: ReviewResult, part: Part, marks: ReviewedMarks): string {
  const ref: BannerPartRef = { anchor: anchorOf(part) };
  const anchor = JSON.stringify(ref.anchor);
  const order = partsInReadingOrder(result);
  const at = order.findIndex((each) => JSON.stringify(anchorOf(each)) === anchor);
  const noise = part.noise !== undefined && isLabelledNoise(part.noise) && noiseSinks(part.noise) ? part.noise : undefined;
  const level =
    noise !== undefined
      ? `**Noise** · ${escapeMarkdown(`${noise.label} · ${noise.state}`)}`
      : part.rank !== undefined
        ? `**${SECTION_TITLES[part.rank.importance]}**`
        : '**Not ranked yet**';
  const position = at < 0 ? [] : [`part ${at + 1} of ${order.length}`];
  const lines = [[level, ...position, reviewedBox(part, marks, ref)].join(' · ')];
  if (noise !== undefined) {
    lines.push(escapeMarkdown(noise.blindSpot));
  } else if (part.rank !== undefined) {
    lines.push(escapeMarkdown(part.rank.reason));
    const signals = part.rank.signals.length === 0 ? [] : [`Signals: ${part.rank.signals.map(escapeMarkdown).join(' · ')}`];
    lines.push([...signals, escapeMarkdown(rankingLine(result.ranking))].join(' · '));
  }
  lines.push(
    [
      ...ASK_KINDS.map((kind) => commandLink(ASKS[kind].title, askCommand(kind), [ref])),
      commandLink('Why this matters', WHY_THIS_MATTERS_COMMAND, [ref]),
      commandLink('Comment on this part…', COMMENT_ON_PART_COMMAND, [ref]),
    ].join(' · '),
  );
  return lines.join('\n\n');
}

/**
 * The banner's reviewed checkbox: ticked, with the link that clears the
 * mark, or empty, with the link that sets it — and, when the part's
 * content changed since the reviewer marked it, saying so.
 */
function reviewedBox(part: Part, marks: ReviewedMarks, ref: BannerPartRef): string {
  const state = reviewedState(part, marks);
  if (state === 'reviewed') return `☑ Reviewed · ${commandLink('Clear the reviewed mark', MARK_REVIEWED_COMMAND, [ref, false])}`;
  const mark = `☐ ${commandLink('Mark reviewed', MARK_REVIEWED_COMMAND, [ref, true])}`;
  return state === 'changed since marked' ? `${mark} — ${CHANGED_SINCE_MARKED}` : mark;
}

/**
 * The banner above the selected part's diff (ADR 0007): the editor's own
 * file comment on the part's first file — on its head side, or its base
 * side when the file is deleted — which the editor shows at the top of
 * that file, where the part's diff starts. Its thread is read-only and holds one comment, the
 * banner's body, whose links are the only commands it runs. One part has
 * a banner at a time, and showing it again with fresh marks or a new
 * result updates it in place.
 */
export class PartBanner implements vscode.Disposable {
  private readonly controller: vscode.CommentController;

  private thread: vscode.CommentThread | undefined;

  constructor() {
    this.controller = vscode.comments.createCommentController(PART_BANNER_CONTROLLER_ID, 'Second Look part');
  }

  /** Shows the banner of one part of the result, replacing any other part's. */
  show(result: ReviewResult, part: Part, marks: ReviewedMarks): void {
    const [file] = partFiles(result.copies, part);
    if (file === undefined) {
      this.clear();
      return;
    }
    const uri = part.changeKind === 'deletion' ? file.original : file.modified;
    if (this.thread === undefined || this.thread.uri.toString() !== uri.toString()) {
      this.clear();
      // A thread at no line is the editor's own file comment; it is created
      // over a line first, then let loose of it.
      this.thread = this.controller.createCommentThread(uri, new vscode.Range(0, 0, 0, 0), []);
      this.thread.range = undefined;
      this.thread.canReply = false;
      this.thread.contextValue = PART_BANNER_CONTEXT;
      this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
    const body = new vscode.MarkdownString(bannerBody(result, part, marks));
    body.isTrusted = { enabledCommands: [...BANNER_COMMANDS] };
    this.thread.label = part.name ?? part.path;
    this.thread.comments = [{ body, mode: vscode.CommentMode.Preview, author: { name: 'Second Look' } }];
  }

  /** Removes the banner. */
  clear(): void {
    this.thread?.dispose();
    this.thread = undefined;
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}
