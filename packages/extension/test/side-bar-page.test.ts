import { beforeEach, describe, expect, it } from 'vitest';
import { applyMark, markedPart, NO_MARKS, type Comment, type Part, type ReviewedMarks } from '@second-look/engine';
import {
  MARK_REVIEWED_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_OVERVIEW_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
} from '../src/commands.js';
import { SideBarProvider } from '../src/side-bar/provider.js';
import type { SideBarState } from '../src/side-bar/steps.js';
import { anchorOf, buildTree, pendingReviewSection } from '../src/tree.js';
import { mixedResult } from './results.js';
import { stub, window } from './vscode-stub.js';

/**
 * The page's own behaviour, driven end to end: the script the side bar ships
 * runs here unchanged, inside a document double small enough to read, against
 * the real provider, so a press travels page script → provider message →
 * command registry the way it does in the editor. The document is a fixture;
 * everything it surrounds is the product.
 */

const SETTINGS = { agent: 'claude-code' as const, model: 'sonnet', effort: 'high', account: '' };
const NOW = new Date('2026-10-06T12:00:00Z');

function marked(...parts: Part[]): ReviewedMarks {
  return parts.reduce((marks, each) => applyMark(marks, markedPart(each), true, NOW), NO_MARKS);
}

/** A part row's checkbox id and open-button id, as the page builds them. */
function rowIds(part: Part): { checkbox: string; open: string } {
  const anchor = anchorOf(part);
  const key = `${anchor.path}@${anchor.hunk?.oldStart ?? ''},${anchor.hunk?.newStart ?? ''}`;
  return { checkbox: `mark-${key}`, open: `open-${key}` };
}

/** One element of the document double: the attributes, the tree and the
 * listeners the page's script touches, and nothing more. */
class Element {
  readonly children: Element[] = [];
  parent: Element | undefined;
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: { target: Element }) => void)[]>();
  private ownerField: Document | undefined;

  constructor(readonly tagName: string) {}

  /** The document the element belongs to: its own, or the one its parent carries. */
  get owner(): Document | undefined {
    return this.ownerField ?? this.parent?.owner;
  }

  set owner(value: Document | undefined) {
    this.ownerField = value;
  }

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  /** The properties the page's script reads as fields, as the browser exposes attributes it knows. */
  get type(): string {
    return this.attributes.get('type') ?? '';
  }

  get disabled(): boolean {
    return this.attributes.has('disabled');
  }

  get checked(): boolean {
    return this.attributes.has('checked');
  }

  /** Hides or shows the element, as assigning the hidden property does. */
  set hidden(hidden: boolean) {
    if (hidden) this.setAttribute('hidden', '');
    else this.attributes.delete('hidden');
  }


  get classList(): { contains(name: string): boolean } {
    return { contains: (name) => (this.attributes.get('class') ?? '').split(/\s+/).includes(name) };
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: Element): void {
    child.parent = this;
    this.children.push(child);
  }

  /** Whether this element holds the element, or is it. */
  contains(element: Element | undefined): boolean {
    for (let node: Element | undefined = element; node !== undefined; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }

  /** The nearest self-or-ancestor the selector names: a tag, or a class. */
  closest(selector: string): Element | null {
    const match = (element: Element): boolean =>
      selector.startsWith('.') ? element.classList.contains(selector.slice(1)) : element.tagName === selector;
    for (let node: Element | undefined = this; node !== undefined; node = node.parent) {
      if (match(node)) return node;
    }
    return null;
  }

  /** The first descendant the selector names, or none. */
  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Every descendant the selector names: a tag, a class, or a tag with classes. */
  querySelectorAll(selector: string): Element[] {
    const parts = selector.split('.');
    const tag = parts[0]!;
    const classes = parts.slice(1);
    const match = (element: Element): boolean =>
      (tag === '' || element.tagName === tag) && classes.every((name) => element.classList.contains(name));
    const found: Element[] = [];
    const walk = (element: Element): void => {
      for (const child of element.children) {
        if (match(child)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  /** Replaces the element's children with the markup, as setting innerHTML does. */
  set innerHTML(html: string) {
    this.children.length = 0;
    for (const child of parse(html)) this.appendChild(child);
  }

  addEventListener(type: string, listener: (event: { target: Element }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Fires the event on this element, as a bubbling press reaches the root. */
  dispatch(type: string): void {
    for (let node: Element | undefined = this; node !== undefined; node = node.parent) {
      for (const listener of node.listeners.get(type) ?? []) listener({ target: this });
    }
  }

  focus(): void {
    this.owner?.becomesActive(this);
  }
}

/** The document the page's script reads: id lookup, the active element, and the tree the parser built. */
class Document {
  readonly documentElement: Element;
  private active: Element | undefined;

  constructor() {
    this.documentElement = new Element('html');
    this.documentElement.owner = this;
  }

  getElementById(id: string): Element | null {
    let found: Element | null = null;
    const walk = (element: Element): void => {
      if (found === null && element.id === id) found = element;
      for (const child of element.children) walk(child);
    };
    walk(this.documentElement);
    return found;
  }

  get activeElement(): Element | undefined {
    return this.active;
  }

  becomesActive(element: Element): void {
    this.active = element;
  }
}

/** Parses the page's markup — the shapes `escapeHtml` and the templates emit — into elements; text is never read. */
function parse(html: string): Element[] {
  const VOID = new Set(['input', 'meta', 'br', 'hr', 'img', 'link']);
  const decode = (value: string): string =>
    value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!,
    );
  const root = new Element('#fragment');
  const stack: Element[] = [root];
  const tags = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    const closing = match[1] === '/';
    const tag = match[2]!;
    const rawAttributes = match[3]!;
    const selfClosing = match[4] !== '';
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]!.tagName === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const element = new Element(tag);
    const attributes = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributes.exec(rawAttributes)) !== null) {
      element.setAttribute(attribute[1]!, decode(attribute[2] ?? ''));
    }
    stack.at(-1)!.appendChild(element);
    if (!selfClosing && !VOID.has(tag)) stack.push(element);
  }
  return root.children;
}

/** The window the page's script listens on, and the message the editor would deliver. */
class WindowShim {
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  /** Delivers a message the extension posted, as the webview's host does. */
  deliver(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

/** The page as the editor loads it: the script the provider served, run against a document it can act on. */
class LoadedPage {
  readonly document = new Document();
  private readonly windowShim = new WindowShim();
  readonly root: Element;

  constructor(
    html: string,
    /** What the page's presses become: the messages it posts, delivered to the provider. */
    onMessage: (message: unknown) => void,
  ) {
    this.root = new Element('main');
    this.root.setAttribute('id', 'root');
    this.document.documentElement.appendChild(this.root);
    // The page arrives with its first cards already drawn, as the extension sets it.
    for (const child of parse(/<main id="root">([\s\S]*)<\/main>/.exec(html)![1]!)) this.root.appendChild(child);
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const acquireVsCodeApi = (): { postMessage(message: unknown): void } => ({ postMessage: onMessage });
    new Function('document', 'window', 'acquireVsCodeApi', script)(this.document, this.windowShim, acquireVsCodeApi);
  }

  /** Delivers a render the extension posted. */
  render(body: string): void {
    this.windowShim.deliver({ type: 'render', body });
  }

  /** The element with this id, as the script would look it up. */
  element(id: string): Element {
    const element = this.document.getElementById(id);
    if (element === null) throw new Error(`no element #${id}`);
    return element;
  }

  /** A press on the element, as a click the browser bubbles to the root. */
  click(id: string): void {
    this.element(id).dispatch('click');
  }

  /** Ticks or clears a checkbox, as a press on it does, and reports the change. */
  tick(id: string, checked: boolean): void {
    const box = this.element(id);
    if (checked) box.setAttribute('checked', '');
    else box.attributes.delete('checked');
    box.dispatch('change');
  }
}

/** Loads the side bar the way the editor does: the provider resolved, then its page's script run. */
function loadSideBar(initial: SideBarState): { provider: SideBarProvider; page: LoadedPage; view: (typeof stub.webviewViewProviders)[number] } {
  const provider = new SideBarProvider(initial);
  window.registerWebviewViewProvider(REVIEW_TREE_VIEW, provider);
  const entry = stub.webviewViewProviders[0]!;
  const view = entry.resolve();
  const page = new LoadedPage(view.webview.html, (message) => view.webview.receive(message));
  return { provider, page, view: entry };
}

/** A review's state, as the session builds it, so a second render can follow a first. */
function reviewState(overrides: Partial<SideBarState> = {}, comments: Comment[] = []): SideBarState {
  const result = overrides.result ?? mixedResult();
  const marks = overrides.marks ?? NO_MARKS;
  return {
    settings: SETTINGS,
    result,
    marks,
    sections: [...(comments.length > 0 ? [pendingReviewSection(comments)] : []), ...buildTree(result, marks)],
    reviewing: false,
    storyRead: false,
    ...overrides,
  };
}

/** Every render the provider posted since the last look, in order. */
function postedBodies(view: (typeof stub.webviewViewProviders)[number]): string[] {
  return view.views[0]!.webview.posted.filter((message: unknown): message is { body: string } => typeof message === 'object' && message !== null && (message as { type?: string }).type === 'render').map((message) => message.body);
}

describe("the side bar's page script", () => {
  beforeEach(() => stub.reset());

  it('reports every press as the message the provider reads, which runs the existing command', () => {
    const result = mixedResult();
    const { page } = loadSideBar(reviewState());
    const first = rowIds(result.parts[0]!);

    // A folded card opens on its title's press, and folds again on the next.
    expect(page.element('step-4-title').getAttribute('aria-expanded')).toBe('false');
    expect(page.element('step-4-body').hasAttribute('hidden')).toBe(true);
    page.click('step-4-title');
    expect(page.element('step-4-title').getAttribute('aria-expanded')).toBe('true');
    expect(page.element('step-4-body').hasAttribute('hidden')).toBe(false);
    page.click('step-4-title');
    expect(page.element('step-4-title').getAttribute('aria-expanded')).toBe('false');
    expect(page.element('step-4-body').hasAttribute('hidden')).toBe(true);
    page.click('step-4-title');

    // A part's name opens the part; its checkbox ticks it through the mark-reviewed path.
    page.click(first.open);
    page.tick(first.checkbox, true);
    page.click('step-2-review');
    page.click('step-3-overview');
    page.click('step-4-nextPart');
    page.click('step-4-allParts');
    page.click('step-8-send');

    expect(stub.executedCommands).toEqual([
      { id: OPEN_PART_COMMAND, args: [result.parts[0]] },
      { id: MARK_REVIEWED_COMMAND, args: [{ anchor: anchorOf(result.parts[0]!) }, true] },
      { id: REVIEW_COMMAND, args: [] },
      { id: OPEN_OVERVIEW_COMMAND, args: [] },
      { id: OPEN_PART_COMMAND, args: [result.parts[0]] },
      { id: OPEN_ALL_PARTS_COMMAND, args: [] },
      { id: SUBMIT_REVIEW_COMMAND, args: [] },
    ]);
  });

  it('redraws by message, keeping the cards the reviewer opened, until the current step moves', () => {
    const result = mixedResult();
    const { provider, page, view } = loadSideBar(reviewState());
    const bodies = postedBodies(view);
    page.render(bodies.at(-1)!);

    // The reviewer opens a card that is not the current one; a redraw keeps it.
    page.click('step-5-title');
    expect(page.element('step-5-body').hasAttribute('hidden')).toBe(false);
    provider.update(reviewState({ message: '2 parts changed since your last look.' }), undefined);
    page.render(postedBodies(view).at(-1)!);
    expect(page.element('step-5-body').hasAttribute('hidden')).toBe(false);

    // The current step moves: the reviewer's folds give way to the cards as drawn.
    page.click('step-6-title');
    expect(page.element('step-6-body').hasAttribute('hidden')).toBe(false);
    provider.update(reviewState({ storyRead: true, marks: marked(...result.parts) }), undefined);
    page.render(postedBodies(view).at(-1)!);
    expect(page.element('step-3-title').getAttribute('aria-expanded')).toBe('false');
    expect(page.element('step-5-title').getAttribute('aria-expanded')).toBe('true');
    expect(page.element('step-5-body').hasAttribute('hidden')).toBe(false);
    expect(page.element('step-6-title').getAttribute('aria-expanded')).toBe('false');
  });

  it('gives the keyboard back the element it held across a redraw', () => {
    const result = mixedResult();
    const { provider, page, view } = loadSideBar(reviewState({ storyRead: true }));
    page.render(postedBodies(view).at(-1)!);
    const open = rowIds(result.parts[0]!).open;
    page.element(open).focus();
    expect(page.document.activeElement?.id).toBe(open);

    provider.update(reviewState({ storyRead: true, message: 'Still reading.' }), undefined);
    page.render(postedBodies(view).at(-1)!);

    expect(page.document.activeElement?.id).toBe(open);
  });

  it('offers only native controls a keyboard can work, each named for a screen reader', () => {
    const result = mixedResult();
    const comment: Comment = { kind: 'line', path: 'src/retry.py', line: 5, side: 'head', body: 'Why five?' };
    const { page } = loadSideBar(reviewState({ storyRead: true, marks: marked(result.parts[0]!) }, [comment]));

    // Every interactive element is a real button or checkbox: Tab reaches them, Space works the checkbox, Enter the button.
    const interactive: Element[] = [];
    const walk = (element: Element): void => {
      if (['button', 'input'].includes(element.tagName)) interactive.push(element);
      for (const child of element.children) walk(child);
    };
    walk(page.root);
    expect(interactive.length).toBeGreaterThan(20);
    for (const element of interactive) {
      if (element.tagName === 'input') {
        expect(element.getAttribute('type')).toBe('checkbox');
        expect(element.getAttribute('aria-label')).toMatch(/^Reviewed: /);
      } else {
        expect(element.getAttribute('type')).toBe('button');
      }
    }
    // The current step is the one marked, its card the open one, and each body a labelled region.
    expect(page.element('step-4').getAttribute('aria-current')).toBe('step');
    expect(page.element('step-4-title').getAttribute('aria-expanded')).toBe('true');
    expect(page.element('step-4-body').getAttribute('role')).toBe('region');
    expect(page.element('step-4-body').getAttribute('aria-labelledby')).toBe('step-4-title');
    expect(page.element('step-3-title').getAttribute('aria-expanded')).toBe('false');
  });
});
