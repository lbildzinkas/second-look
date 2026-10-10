import { runInNewContext } from 'node:vm';

/**
 * A hand-written DOM double for the overview page: only what the page's
 * own inline script reads, so a test can run that script as shipped and
 * watch what it does to the page and posts to the host. No element tree
 * is kept: the script reaches elements by selector or id, so the double
 * holds the elements the markup opens, flat.
 */

/** One element of the rendered page, as the page's script reads it: its attributes and classes, the listeners wired on it, and where its box sits. */
export class ElementDouble {
  readonly classes: Set<string>;
  readonly listeners: Record<string, () => void> = {};
  /** The top of the element's box, which scrolling moves. */
  top = 0;
  /** The block the element was last scrolled into view with, when it was. */
  scrolledIntoView: string | undefined;
  hidden: boolean;
  private readonly attributes: Map<string, string>;
  readonly tag: string;

  constructor(tag: string, attributes: Map<string, string>) {
    this.tag = tag;
    this.attributes = attributes;
    this.classes = new Set((this.getAttribute('class') ?? '').split(/\s+/).filter((name) => name !== ''));
    this.hidden = this.attributes.has('hidden');
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }

  /** The element's id, which the page's script reads as a property. */
  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] = listener;
  }

  click(): void {
    this.listeners.click?.();
  }

  getBoundingClientRect(): { top: number } {
    return { top: this.top };
  }

  scrollIntoView(options: { block: string }): void {
    this.scrolledIntoView = options.block;
  }

  get classList(): { toggle(name: string, on: boolean): void } {
    return {
      toggle: (name, on) => {
        if (on) this.classes.add(name);
        else this.classes.delete(name);
      },
    };
  }
}

/** A rendered overview page whose own script has run against the double. */
export class PageDouble {
  readonly elements: ElementDouble[] = [];
  /** Every message the page posted to its host, in order. */
  readonly posted: unknown[] = [];
  readonly window = { innerHeight: 600, scrollY: 0 };
  readonly documentElement = { scrollHeight: 2000 };
  private readonly windowListeners: (() => void)[] = [];

  /** Loads a rendered page: holds its elements, then runs the page's own nonce-marked script against the double. */
  static load(html: string): PageDouble {
    const page = new PageDouble();
    for (const [, tag, rawAttributes] of html.matchAll(/<([a-z]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
      const attributes = new Map<string, string>();
      for (const [, name, value] of rawAttributes!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes.set(name!, value ?? '');
      page.elements.push(new ElementDouble(tag!, attributes));
    }
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)![1]!;
    runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: (message: unknown) => page.posted.push(message) }),
      document: {
        querySelectorAll: (selector: string) => page.matching(selector),
        querySelector: (selector: string) => page.matching(selector).at(0) ?? null,
        getElementById: (id: string) => page.byId(id) ?? null,
        documentElement: page.documentElement,
      },
      window: { ...page.window, addEventListener: (_type: string, listener: () => void) => page.windowListeners.push(listener) },
    });
    return page;
  }

  /** The elements a simple selector names: an optional tag, class names, and one attribute to require. */
  matching(selector: string): ElementDouble[] {
    const parsed = /^([a-z]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)\])?$/.exec(selector);
    if (parsed === null) throw new Error(`the double cannot parse the selector ${selector}`);
    const [, tag, classNames, attribute] = parsed;
    return this.elements.filter(
      (element) =>
        (tag === undefined || element.tag === tag) &&
        (classNames === undefined || classNames.split('.').every((name) => name === '' || element.classes.has(name))) &&
        (attribute === undefined || element.getAttribute(attribute) !== null),
    );
  }

  byId(id: string): ElementDouble | undefined {
    return this.elements.find((element) => element.getAttribute('id') === id);
  }

  /** The page scrolls, and every listener the script asked the window for hears it. */
  scroll(): void {
    for (const listener of this.windowListeners) listener();
  }
}
