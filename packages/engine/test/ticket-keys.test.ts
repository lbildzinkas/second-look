import { describe, expect, it } from 'vitest';
import { MAX_KEY_REFERENCES, findKeyReferences, isTicketKey } from '../src/ticket-keys.js';

/** The key references a pull request makes that names keys in one place only. */
function keysIn(place: 'head' | 'title' | 'description', text: string): string[] {
  const pullRequest = { head: 'feature/login', title: 'Fix the login', description: '', [place]: text };
  return findKeyReferences(pullRequest).map((reference) => reference.key);
}

describe('findKeyReferences', () => {
  it.each(['UTF-8', 'SHA-256', 'ISO-8601', 'CVE-2024-1234', 'RFC-7231', 'HTTP-2', 'PEP-8', 'GPT-4', 'ES-2022', 'MD-5', 'AES-128', 'TLS-1', 'SSL-3', 'IEEE-754', 'ECMA-262'])(
    'finds no key in the technical name %s',
    (name) => {
      for (const place of ['head', 'title', 'description'] as const) {
        expect(keysIn(place, `Encode as ${name} before sending`)).toEqual([]);
        expect(keysIn(place, name)).toEqual([]);
      }
    },
  );

  it.each([
    ['head', 'feature/ABC-123_login', 'ABC-123'],
    ['title', 'ABC-123: fix', 'ABC-123'],
    ['description', 'Ticket: https://x.atlassian.net/browse/PORT-42', 'PORT-42'],
    ['description', '[the ticket](https://x.atlassian.net/browse/PORT-42?focusedCommentId=1)', 'PORT-42'],
    ['head', 'ABC-123', 'ABC-123'],
    ['title', '(PROJ_2-9) tidy', 'PROJ_2-9'],
  ] as const)('finds the key in the %s %j', (place, text, key) => {
    expect(keysIn(place, text)).toEqual([key]);
  });

  it.each([
    ['an ISO date', 'Released 2024-01-15'],
    ['an ISO date and time', 'since 2024-01-15T10:00:00Z'],
    ['a lowercase key', 'feature/abc-123-login'],
    ['a key in mixed case', 'Abc-123'],
    ['a key glued to a word before it', 'xABC-123'],
    ['a key glued to a word after it', 'ABC-123x'],
    ['a number with a leading zero', 'ABC-0123'],
    ['a one-letter project', 'A-1'],
    ['a project longer than ten characters', 'ABCDEFGHIJK-1'],
    ['a bare number', '#42 and 123'],
  ])('finds no key in %s', (_, text) => {
    expect(keysIn('title', text)).toEqual([]);
  });

  it('takes the branch name first, then the title, then the description, each key once where it is named first', () => {
    expect(
      findKeyReferences({
        head: 'feature/DEF-2_and_ABC-1',
        title: 'GHI-3: retry, for ABC-1',
        description: 'Closes DEF-2 and JKL-4 (see https://x.atlassian.net/browse/GHI-3).',
      }),
    ).toEqual([
      { key: 'DEF-2', place: 'branch' },
      { key: 'ABC-1', place: 'branch' },
      { key: 'GHI-3', place: 'title' },
      { key: 'JKL-4', place: 'description' },
    ]);
  });

  it(`keeps at most ${MAX_KEY_REFERENCES} keys, counting a key named twice once`, () => {
    const found = findKeyReferences({
      head: 'A1-1/A2-2',
      title: 'A1-1 A3-3 A2-2',
      description: 'A4-4 A1-1 A5-5 A6-6 A7-7',
    });
    expect(found).toEqual([
      { key: 'A1-1', place: 'branch' },
      { key: 'A2-2', place: 'branch' },
      { key: 'A3-3', place: 'title' },
      { key: 'A4-4', place: 'description' },
      { key: 'A5-5', place: 'description' },
    ]);
  });

  it('keeps a key the branch name repeats once', () => {
    expect(findKeyReferences({ head: 'ABC-1/ABC-1', title: 'ABC-1', description: 'ABC-1' })).toEqual([{ key: 'ABC-1', place: 'branch' }]);
  });

  it('finds keys beside the technical names it passes over', () => {
    expect(keysIn('description', 'Hash with SHA-256 (CVE-2024-1234) for PAY-17, encoded as UTF-8.')).toEqual(['PAY-17']);
  });

  it("finds no key in the description's HTML comments, which GitHub does not show", () => {
    expect(keysIn('description', '<!-- Name the Jira ticket, such as PROJ-123 -->\nFixes the login.')).toEqual([]);
    expect(keysIn('description', '<!-- template -->\nFor WEB-9.')).toEqual(['WEB-9']);
  });

  it('finds no key in a pull request that names none', () => {
    expect(findKeyReferences({ head: 'main', title: 'Bump the packages to 0.2.2', description: 'Closes #187.' })).toEqual([]);
  });
});

describe('isTicketKey', () => {
  it.each(['ABC-123', 'J2_X-9'])('accepts %s', (text) => {
    expect(isTicketKey(text)).toBe(true);
  });

  it.each(['abc-123', 'ABC-0', 'ABC-012', 'A-1', 'ABC-123 ', 'xABC-123 y', ''])('rejects %j', (text) => {
    expect(isTicketKey(text)).toBe(false);
  });
});
