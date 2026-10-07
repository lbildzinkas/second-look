import * as vscode from 'vscode';
import type { DocLink, ReviewResult } from '@second-look/engine';
import { CHANGE_SCHEME } from './change-copies.js';
import { escapeMarkdown } from './findings.js';

/**
 * The documentation links of a library name the reviewer hovers on the
 * head side of a part's diff: each API the review found used on that
 * line under that name, every link from a published inventory first,
 * then the agent's suggestions, labelled as such.
 */
export function hoveredLinks(result: ReviewResult | undefined, path: string, line: number, name: string): DocLink[] {
  const links = (result?.docLinks?.links ?? []).filter((link) => link.uses.some((use) => use.path === path && use.line === line && use.name === name));
  return [...links.filter((link) => link.from === 'inventory'), ...links.filter((link) => link.from === 'agent')];
}

/** An address as a Markdown link target: its parentheses and spaces escaped, so it cannot end the link early. */
function linkTarget(url: string): string {
  return url.replace(/[()\s]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** The hover's Markdown: one line per link, saying where it came from and, for a suggestion, that nothing checked it. */
export function docHoverMarkdown(links: readonly DocLink[]): string {
  return links
    .map((link) => {
      const library = escapeMarkdown(link.ecosystem === '.NET' ? `.NET ${link.version}` : `${link.library} ${link.version}`);
      const api = `[${escapeMarkdown(link.api)}](${linkTarget(link.url)})`;
      return link.from === 'inventory'
        ? `${api}: documentation of ${library}, from its published inventory`
        : `**Suggested by the agent, not checked:** ${api}, for ${library}`;
    })
    .join('\n\n');
}

/**
 * Shows the documentation links of the library API under the pointer on
 * the head side of a part's diff, for the review shown, and only at the
 * head commit it reviewed. The Markdown is not trusted: it runs no
 * command, and a link only opens its page.
 */
export class DocLinkHovers implements vscode.HoverProvider {
  private readonly shown: () => ReviewResult | undefined;

  constructor(shown: () => ReviewResult | undefined) {
    this.shown = shown;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const { uri } = document;
    const result = this.shown();
    if (result === undefined || uri.scheme !== CHANGE_SCHEME || uri.authority !== 'head') return undefined;
    const [commit, ...rest] = uri.path.replace(/^\//, '').split('/');
    if (commit !== result.copies.head.commit || rest.length === 0) return undefined;
    const range = document.getWordRangeAtPosition(position);
    if (range === undefined) return undefined;
    const links = hoveredLinks(result, rest.join('/'), position.line + 1, document.getText(range));
    if (links.length === 0) return undefined;
    const markdown = new vscode.MarkdownString(docHoverMarkdown(links));
    markdown.isTrusted = false;
    return new vscode.Hover(markdown, range);
  }
}
