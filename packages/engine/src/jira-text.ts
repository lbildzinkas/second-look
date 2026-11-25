/**
 * A Jira ticket's text, read model-free (ADR 0010): its description
 * flattened to lines, the acceptance criteria section under the
 * configured heading, and the quote form the fetch run's answer is
 * checked in against what Jira sent. Ticket text is untrusted: it is
 * parsed and never followed.
 */

/** The longest description kept, so a ticket cannot flood the result; a longer one is cut at a line, saying so. */
export const MAX_JIRA_DESCRIPTION = 30_000;

/** The most criteria one ticket gives. */
export const MAX_JIRA_CRITERIA = 50;

/** The longest criterion quote kept, as for a GitHub issue. */
const MAX_QUOTE = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodesOf(node: Record<string, unknown>): Record<string, unknown>[] {
  const content = node['content'];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function attr(node: Record<string, unknown>, name: string): unknown {
  return isRecord(node['attrs']) ? node['attrs'][name] : undefined;
}

/** Whether a text node carries the strong mark. */
function isStrong(node: Record<string, unknown>): boolean {
  return Array.isArray(node['marks']) && node['marks'].some((mark) => isRecord(mark) && mark['type'] === 'strong');
}

/** One inline node's text: text as written, a mention, emoji, status or link card by what it shows, a hard break as a new line. */
function inlineText(node: Record<string, unknown>): string {
  switch (node['type']) {
    case 'text':
      return typeof node['text'] === 'string' ? node['text'] : '';
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'status':
    case 'emoji': {
      const text = attr(node, 'text') ?? attr(node, 'shortName');
      return typeof text === 'string' ? text : '';
    }
    case 'inlineCard':
    case 'blockCard': {
      const url = attr(node, 'url');
      return typeof url === 'string' ? url : '';
    }
    case 'date': {
      const stamp = Number(attr(node, 'timestamp'));
      return Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : '';
    }
    default:
      return nodesOf(node).map(inlineText).join('');
  }
}

/** A paragraph's text, and whether all of it is bold — a line Jira users write in place of a heading. */
function paragraphText(node: Record<string, unknown>): { text: string; bold: boolean } {
  const parts = nodesOf(node);
  const text = parts.map(inlineText).join('');
  const written = parts.filter((part) => part['type'] === 'text' && typeof part['text'] === 'string' && part['text'].trim() !== '');
  return { text, bold: written.length > 0 && written.every(isStrong) && parts.every((part) => part['type'] === 'text') };
}

/** Lines with a prefix on the first and an indent on the rest, so a list item's broken lines stay with it. */
function prefixed(text: string, first: string, rest: string): string[] {
  return text.split('\n').map((line, index) => `${index === 0 ? first : rest}${line}`);
}

/** One block node as lines, nested lists indented under their item. */
function blockLines(node: Record<string, unknown>, indent: string): string[] {
  switch (node['type']) {
    case 'paragraph': {
      const { text, bold } = paragraphText(node);
      if (text.trim() === '') return [];
      return bold ? [`${indent}**${text.trim()}**`] : prefixed(text, indent, indent);
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(attr(node, 'level')) || 1, 1), 6);
      const text = nodesOf(node).map(inlineText).join('').replace(/\n/g, ' ').trim();
      return text === '' ? [] : [`${'#'.repeat(level)} ${text}`];
    }
    case 'bulletList':
    case 'orderedList': {
      const start = Number(attr(node, 'order'));
      let number = Number.isInteger(start) && start > 0 ? start : 1;
      return nodesOf(node).flatMap((item) => itemLines(item, indent, node['type'] === 'bulletList' ? '- ' : `${number++}. `));
    }
    case 'taskList':
      return nodesOf(node).flatMap((item) =>
        item['type'] === 'taskItem'
          ? prefixed(nodesOf(item).map(inlineText).join(''), `${indent}- [${attr(item, 'state') === 'DONE' ? 'x' : ' '}] `, `${indent}  `)
          : blockLines(item, `${indent}  `),
      );
    case 'blockquote':
      return nodesOf(node).flatMap((child) => blockLines(child, indent)).map((line) => `> ${line}`);
    case 'codeBlock':
      return ['```', ...nodesOf(node).map(inlineText).join('').split('\n'), '```'];
    case 'rule':
      return ['---'];
    case 'table':
      return nodesOf(node).map((row) => nodesOf(row).map((cell) => nodesOf(cell).flatMap((child) => blockLines(child, '')).join(' ').trim()).join(' | '));
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
    case 'mediaInline':
      return [];
    default: {
      const children = nodesOf(node);
      if (children.length > 0) return children.flatMap((child) => blockLines(child, indent));
      const text = inlineText(node);
      return text.trim() === '' ? [] : prefixed(text, indent, indent);
    }
  }
}

/** One list item as lines: its first paragraph after the marker, the rest of it indented beneath. */
function itemLines(item: Record<string, unknown>, indent: string, marker: string): string[] {
  const nested = `${indent}  `;
  const [first, ...rest] = nodesOf(item);
  if (first === undefined) return [];
  const head = first['type'] === 'paragraph' ? prefixed(paragraphText(first).text, `${indent}${marker}`, nested) : [`${indent}${marker.trimEnd()}`, ...blockLines(first, nested)];
  return [...head, ...rest.flatMap((child) => blockLines(child, nested))];
}

/**
 * A Jira description as lines: markdown or wiki text as Jira sent it, or
 * its rich-text document (ADF) flattened — headings as `#` lines, a
 * paragraph that is only bold as a `**…**` line, bullets, numbered items
 * and task items with their markers, nested items indented, blocks
 * apart by a blank line. Media is left out. A description longer than
 * {@link MAX_JIRA_DESCRIPTION} is cut at a line, saying so.
 */
export function flattenJiraDescription(description: unknown): string {
  let text: string;
  if (typeof description === 'string') text = description.replace(/\r\n?/g, '\n');
  else if (isRecord(description)) {
    text = nodesOf(description)
      .map((block) => blockLines(block, '').join('\n'))
      .filter((block) => block !== '')
      .join('\n\n');
  } else text = '';
  if (text.length <= MAX_JIRA_DESCRIPTION) return text;
  const cut = text.lastIndexOf('\n', MAX_JIRA_DESCRIPTION);
  return `${text.slice(0, cut > 0 ? cut : MAX_JIRA_DESCRIPTION)}\n[… cut: the description is longer than ${MAX_JIRA_DESCRIPTION} characters]`;
}

/** An ATX heading's text, or a Jira wiki `h3.` heading's. */
const HEADING = /^ {0,3}(?:#{1,6}[ \t]+(.+?)[ \t]*#*|h[1-6]\.[ \t]+(.+?))[ \t]*$/;

/** A line that is only bold text: `**…**`, `__…__`, or Jira wiki's `*…*`, with a colon inside or after it. */
const BOLD_LINE = /^[ \t]*(?:\*\*(.+?)\*\*|__(.+?)__|\*([^*]+)\*)[ \t]*:?[ \t]*$/;

/** A bullet, numbered or task item: its marker dropped, its checkbox too, its text captured. */
const ITEM = /^([ \t]*)(?:[-*+•]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?(.*)$/;

/** A Given/When/Then line of a scenario, `And` and `But` continuing it. */
const SCENARIO_STEP = /^[ \t]*(Given|When|Then|And|But)\b/i;

/** A line that names a scenario, which the steps beneath it make up. */
const SCENARIO_NAME = /^[ \t]*Scenario(?: Outline)?\s*:/i;

/** A line's text as a section heading: an ATX or wiki heading, or a bold line; undefined for any other line. */
function sectionHeading(line: string): string | undefined {
  const heading = HEADING.exec(line);
  const bold = heading === null ? BOLD_LINE.exec(line) : null;
  const text = heading?.[1] ?? heading?.[2] ?? bold?.[1] ?? bold?.[2] ?? bold?.[3];
  return text?.replace(/\*\*|__/g, '').trim().replace(/[ \t]*:$/, '');
}

/** One criterion as the section lists it: its text on one line, and the 1-based line of the description it starts on. */
export interface JiraCriterionLine {
  text: string;
  line: number;
}

/**
 * The acceptance criteria section of a Jira description: under the first
 * heading — or bold line, which Jira users often write in place of one —
 * whose text is the configured heading, matched case-insensitively with
 * a trailing colon allowed, that lists anything. Bullets, numbered items
 * and task items each count as one criterion, nested ones too, and an
 * indented line beneath an item continues it; a Given/When/Then scenario
 * counts as one criterion, its When, Then, And and But lines continuing
 * its Given. Plain words before the first criterion, and a scenario's
 * name, introduce them; another heading or bold line ends the section,
 * and so does a plain line once criteria have started. Undefined when the
 * description has no such section; at most {@link MAX_JIRA_CRITERIA}.
 */
export function jiraCriteriaSection(description: string, heading: string): JiraCriterionLine[] | undefined {
  const lines = description.split('\n');
  const wanted = heading.trim().replace(/:$/, '').trim().toLowerCase();
  let found = false;
  for (let at = 0; at < lines.length; at++) {
    if (sectionHeading(lines[at]!)?.toLowerCase() !== wanted) continue;
    found = true;
    const items: JiraCriterionLine[] = [];
    // Whether the last criterion may take a continuation line: an item, by an indented line; a scenario, by its next step.
    let open: 'item' | 'scenario' | undefined;
    for (let scan = at + 1; scan < lines.length && items.length <= MAX_JIRA_CRITERIA; scan++) {
      const line = lines[scan]!;
      if (line.trim() === '') continue;
      if (sectionHeading(line) !== undefined) break;
      const item = ITEM.exec(line);
      const step = SCENARIO_STEP.exec(line);
      const last = items.at(-1);
      if (item !== null) {
        items.push({ text: item[2]!, line: scan + 1 });
        open = 'item';
      } else if (step !== null && (step[1]!.toLowerCase() === 'given' || open !== 'scenario' || last === undefined)) {
        items.push({ text: line.trim(), line: scan + 1 });
        open = 'scenario';
      } else if (step !== null && last !== undefined) {
        last.text = `${last.text} ${line.trim()}`;
      } else if (open === 'item' && last !== undefined && /^[ \t]/.test(line)) {
        last.text = `${last.text} ${line.trim()}`;
      } else if (SCENARIO_NAME.test(line)) {
        open = undefined;
      } else if (items.length > 0) {
        break;
      }
    }
    const kept = items
      .map(({ text, line }) => ({ text: text.replace(/\s+/g, ' ').trim(), line }))
      .filter((each) => each.text !== '')
      .slice(0, MAX_JIRA_CRITERIA)
      .map((each) => ({ ...each, text: each.text.length > MAX_QUOTE ? `${each.text.slice(0, MAX_QUOTE - 1)}…` : each.text }));
    if (kept.length > 0) return kept;
  }
  return found ? [] : undefined;
}

/** A line's leading quote, heading, list and checkbox marks, which say how a line is laid out, not what it says. */
const LAYOUT_MARKS = /^(?:\s*>)*\s*(?:#{1,6}\s+|h[1-6]\.\s+)?(?:(?:[-*+•]|\d+[.)])\s+)?(?:\[[ xX]\]\s*)?/;

/**
 * A text in the form a quote is compared in: each line's layout marks
 * dropped — quote, heading, bullet, number and checkbox — bold marks
 * dropped, and every run of white space, line breaks among them, as one
 * space. The words, and their order, are left exactly as written, so a
 * paraphrase or an added word never compares equal.
 */
export function quoteForm(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(LAYOUT_MARKS, '').replace(/\*\*|__/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
