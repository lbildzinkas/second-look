import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { changeUri } from '../src/change-copies.js';
import { DocLinkHovers, docHoverMarkdown, hoveredLinks } from '../src/doc-hover.js';
import { isReviewResult } from '../src/protocol.js';
import { overviewHtml, OverviewPanel } from '../src/overview.js';
import { docLinksResult, mixedResult } from './results.js';
import { Hover, Position, Range, stub, type StubMarkdownString } from './vscode-stub.js';

beforeEach(() => stub.reset());

/** A document of one line, as the editor gives a hover provider. */
function document(uri: vscode.Uri, line: string): vscode.TextDocument {
  return {
    uri,
    getWordRangeAtPosition: (position: Position) => {
      const words = [...line.matchAll(/\w+/g)];
      const word = words.find((match) => match.index! <= position.character && position.character < match.index! + match[0].length);
      return word === undefined ? undefined : new Range(position.line, word.index!, position.line, word.index! + word[0].length);
    },
    getText: (range: Range) => line.slice(range.start.character, range.end.character),
  } as unknown as vscode.TextDocument;
}

describe('hoveredLinks', () => {
  it("gives the links of the API a line uses under the hovered name, every inventory link before the agent's", () => {
    const result = docLinksResult();
    const shown = { ...result, docLinks: { ...result.docLinks!, links: [...result.docLinks!.links].reverse() } };
    expect(hoveredLinks(shown, 'src/retry.py', 5, 'retry').map((link) => link.api)).toEqual(['tenacity.retry']);
    expect(hoveredLinks(shown, 'src/retry.py', 5, 'attempts').map((link) => link.from)).toEqual(['agent']);
    expect(hoveredLinks(shown, 'src/retry.py', 6, 'retry')).toEqual([]);
    expect(hoveredLinks(mixedResult(), 'src/retry.py', 5, 'retry')).toEqual([]);
  });

  it("labels a suggestion as the agent's and not checked, and escapes what the result says", () => {
    const [read, suggested] = docLinksResult().docLinks!.links;
    expect(docHoverMarkdown([read!])).toBe(
      '[tenacity\\.retry](https://tenacity.readthedocs.io/en/8.2.3/api.html#tenacity.retry): documentation of tenacity 8\\.2\\.3, from its published inventory',
    );
    expect(docHoverMarkdown([suggested!])).toBe(
      '**Suggested by the agent, not checked:** [tenacity\\.Retrying\\.attempts](https://tenacity.readthedocs.io/en/latest/<b>api</b>.html), for tenacity 8\\.2\\.3',
    );
    expect(docHoverMarkdown([{ ...suggested!, url: 'https://example.org/a b)(c' }])).toContain('(https://example.org/a%20b%29%28c)');
  });
});

/** A position as the editor gives a hover provider. */
function at(line: number, character: number): vscode.Position {
  return new Position(line, character) as unknown as vscode.Position;
}

describe('DocLinkHovers', () => {
  const result = docLinksResult();
  const hovers = new DocLinkHovers(() => result);
  const line = '    for attempt in retry.attempts():';

  it('answers a hover on the head side of the reviewed commit with the links, as untrusted Markdown', () => {
    const hover = hovers.provideHover(document(changeUri('head', result.copies.head.commit, 'src/retry.py'), line), at(4, 22)) as unknown as Hover;
    expect(hover).toBeInstanceOf(Hover);
    const contents = hover.contents as StubMarkdownString & { isTrusted?: boolean };
    expect(contents.value).toMatch(/^\[tenacity\\\.retry\]/);
    expect(contents.isTrusted).toBe(false);
    expect(hover.range).toEqual(new Range(4, 19, 4, 24));
  });

  it('answers nothing on the base side, at another commit, or on a name with no link', () => {
    const there = at(4, 22);
    expect(hovers.provideHover(document(changeUri('base', result.copies.base.commit, 'src/retry.py'), line), there)).toBeUndefined();
    expect(hovers.provideHover(document(changeUri('head', 'another', 'src/retry.py'), line), there)).toBeUndefined();
    expect(hovers.provideHover(document(changeUri('head', result.copies.head.commit, 'src/retry.py'), line), at(4, 9))).toBeUndefined();
    expect(new DocLinkHovers(() => undefined).provideHover(document(changeUri('head', result.copies.head.commit, 'src/retry.py'), line), there)).toBeUndefined();
  });
});

describe('the documentation section', () => {
  it('lists the inventory links, then the suggestions flagged as not checked, then what has no link and what was read', () => {
    const html = overviewHtml({ result: docLinksResult() }, 'nonce');
    const section = html.slice(html.indexOf('<section id="docs">'), html.indexOf('<section id="pipeline">'));
    expect(section).toContain('<h2>Documentation <span class="stamp">pi · zai/glm-4.6 · default effort · doc-links prompt v1</span></h2>');
    const read = section.indexOf('data-doc="0"');
    const suggested = section.indexOf('data-doc="1"');
    expect(read).toBeGreaterThan(0);
    expect(suggested).toBeGreaterThan(read);
    expect(section).toContain('From the published inventory of tenacity 8.2.3, as requirements.txt pins it · used at src/retry.py:5');
    expect(section).toContain('<span class="flag">suggested</span><code>tenacity.Retrying.attempts</code>');
    expect(section).toContain('Suggested by the agent from what it knows, for tenacity 8.2.3 as requirements.txt pins it; not checked');
    expect(section).toContain('https://tenacity.readthedocs.io/en/latest/&lt;b&gt;api&lt;/b&gt;.html');
    expect(section).toContain('No documentation link found for <code>tenacity.TryAgain</code> (tenacity 8.2.3).');
    expect(section).toContain('tenacity 8.2.3: read the Sphinx inventory at https://tenacity.readthedocs.io/en/8.2.3/objects.inv, which documents 8.2.3.');
    expect(html).toContain('<li><b>Documentation links</b> 1 read from published inventories at the pinned version; suggested by pi');
  });

  it('says when no links were looked for, and when they are still coming', () => {
    expect(overviewHtml({ result: mixedResult() }, 'n')).toContain('No documentation links were looked for in this review.');
    expect(overviewHtml({ result: mixedResult(), running: 'mapping the acceptance criteria with pi' }, 'n')).toContain('The documentation links come once the review is done.');
  });

  it('opens a link it lists in the browser, and ignores one it does not have', () => {
    const overview = new OverviewPanel(() => undefined, () => undefined, () => undefined);
    overview.update(docLinksResult());
    overview.open();
    const panel = stub.webviewPanels[0]!;
    panel.webview.receive({ type: 'openDoc', doc: 1 });
    panel.webview.receive({ type: 'openDoc', doc: 7 });
    panel.webview.receive({ type: 'openDoc', doc: '0' });
    expect(stub.openedExternals).toEqual(['https://tenacity.readthedocs.io/en/latest/<b>api</b>.html']);
  });
});

describe('the documentation links over the protocol', () => {
  it('accepts the links as the engine sends them', () => {
    expect(isReviewResult(JSON.parse(JSON.stringify(docLinksResult())))).toBe(true);
  });

  it("refuses a suggestion before an inventory's link, a suggestion with no suggestions to stamp it, and a page that is not https", () => {
    const shown = docLinksResult();
    const docs = shown.docLinks!;
    const [read, suggested] = docs.links;
    expect(isReviewResult({ ...shown, docLinks: { ...docs, links: [suggested, read] } })).toBe(false);
    const { suggestions: _suggestions, ...unstamped } = docs;
    expect(isReviewResult({ ...shown, docLinks: unstamped })).toBe(false);
    expect(isReviewResult({ ...shown, docLinks: { ...docs, links: [{ ...read!, url: 'javascript:alert(1)' }] } })).toBe(false);
    expect(isReviewResult({ ...shown, docLinks: { ...docs, links: [{ ...suggested!, inventory: 'https://example.org/objects.inv' }] } })).toBe(false);
    expect(isReviewResult({ ...shown, docLinks: { ...docs, suggestions: { ...docs.suggestions!, outcome: 'fell back' } } })).toBe(false);
  });
});
