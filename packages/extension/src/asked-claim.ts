import type * as vscode from 'vscode';
import { filesOfPart, type Claim, type ReviewerSelection, type ReviewResult } from '@second-look/engine';
import { CHANGE_SCHEME } from './change-copies.js';

/** What the reviewer has selected in an editor: the document, the selection's 0-based ends and its text. */
export interface EditorSelection {
  uri: vscode.Uri;
  start: { line: number; character: number };
  end: { line: number; character: number };
  text: string;
}

/**
 * The text the reviewer selected on the head side of one of a part's
 * files, at the head commit of the review shown, as a verify ask's
 * selection: its 1-based lines, a selection that ends at the start of a
 * line ending on the line before. Undefined for a selection that holds
 * no text or sits anywhere else, such as on the base side.
 */
export function selectionInPart(result: ReviewResult, part: number, selected: EditorSelection): ReviewerSelection | undefined {
  const { uri, start, end, text } = selected;
  if (uri.scheme !== CHANGE_SCHEME || uri.authority !== 'head' || text.trim() === '') return undefined;
  const [commit, ...rest] = uri.path.replace(/^\//, '').split('/');
  const path = rest.join('/');
  const shown = result.parts[part];
  if (commit !== result.copies.head.commit || shown === undefined || !filesOfPart(shown).some((file) => file.path === path)) return undefined;
  const endLine = end.character === 0 && end.line > start.line ? end.line : end.line + 1;
  return { path, line: start.line + 1, endLine, text };
}

/** The claims a verify ask offers to pick about a part, each with its index in the review's claims. */
export function partClaims(result: ReviewResult, part: number): { index: number; claim: Claim }[] {
  return (result.claims?.claims ?? []).flatMap((claim, index) => (claim.part === part ? [{ index, claim }] : []));
}
