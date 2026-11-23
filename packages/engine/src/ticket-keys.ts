import type { Criteria, KeyReference, KeyReferencePlace, PullRequestSummary } from './protocol.js';

/**
 * Key references (ADR 0010): the ticket keys a pull request names in its
 * branch name, title and description, `…/browse/ABC-123` links among
 * them. Any key shape counts, with no list of project keys to configure;
 * a built-in deny-list drops the technical prefixes that look like keys,
 * such as `UTF-8` or `SHA-256`. A key found here is only a candidate:
 * it becomes a linked ticket only once its issue tracker source returns
 * it. Model-free, and nothing found is followed.
 */

/** The most key references a review keeps, and so the most tickets it will ask a tracker for. */
export const MAX_KEY_REFERENCES = 5;

/**
 * A ticket key: a capital letter, then one to nine capitals, digits or
 * `_`, a hyphen, and a number with no leading zero. Lookarounds rather
 * than word boundaries, so `feature/ABC-123_login` yields `ABC-123`
 * while `xABC-123` and `ABC-123x` yield nothing. A `…/browse/ABC-123`
 * link holds its key after a `/`, so the same pattern finds it.
 */
const KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9_]{1,9})-[1-9]\d*(?![A-Za-z0-9])/g;

/**
 * Prefixes that name a standard, an algorithm, an encoding or a model
 * rather than a project, so their key-shaped mentions — `UTF-8`,
 * `SHA-256`, `ISO-8601`, `CVE-2024-1234`, `RFC-7231`, `HTTP-2`, `PEP-8`,
 * `GPT-4`, `ES-2022` — are never key references.
 */
export const DENIED_KEY_PREFIXES: ReadonlySet<string> = new Set([
  'AES', 'CVE', 'CWE', 'DES', 'ECMA', 'ES', 'GPT', 'GMT', 'HTTP', 'HTTPS', 'IEC', 'IEEE', 'ISO', 'JSR',
  'MD', 'PEP', 'RFC', 'RSA', 'SHA', 'SSL', 'TLS', 'UCS', 'UTC', 'UTF', 'WCAG',
]);

/** An HTML comment: a pull request template's hints sit in one, and GitHub never shows it. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/** Where a pull request's key references are looked for, read in this order. */
export type KeySearch = Pick<PullRequestSummary, 'head' | 'title' | 'description'>;

/** The keys one text names, in the order it names them, the denied prefixes left out. */
function keysIn(text: string): string[] {
  return [...text.matchAll(KEY)].filter((match) => !DENIED_KEY_PREFIXES.has(match[1]!)).map((match) => match[0]);
}

/**
 * The key references a pull request makes: the branch name's first,
 * then the title's, then the description's — its HTML comments, which
 * GitHub hides, left out — each in the order it names them. A key named
 * in more than one place counts once, where it is named first, and at
 * most {@link MAX_KEY_REFERENCES} are kept.
 */
export function findKeyReferences(pullRequest: KeySearch): KeyReference[] {
  const places: [KeyReferencePlace, string][] = [
    ['branch', pullRequest.head],
    ['title', pullRequest.title],
    ['description', pullRequest.description.replace(HTML_COMMENT, '')],
  ];
  const found: KeyReference[] = [];
  const seen = new Set<string>();
  for (const [place, text] of places) {
    for (const key of keysIn(text)) {
      if (seen.has(key)) continue;
      if (found.length === MAX_KEY_REFERENCES) return found;
      seen.add(key);
      found.push({ key, place });
    }
  }
  return found;
}

/** Criteria as a result before version 27 kept them, with no key references. */
export type UnkeyedCriteria = Omit<Criteria, 'keyReferences'> & { keyReferences?: KeyReference[] };

/**
 * Criteria kept before key references were looked for, read as they are
 * kept now: their key references found in the pull request they were
 * read for, as a review finds them. Criteria that already keep them are
 * kept as they are.
 */
export function withKeyReferences(criteria: UnkeyedCriteria, pullRequest: KeySearch): Criteria {
  return { ...criteria, keyReferences: criteria.keyReferences ?? findKeyReferences(pullRequest) };
}
