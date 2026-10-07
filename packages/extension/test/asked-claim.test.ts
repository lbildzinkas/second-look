import { describe, expect, it } from 'vitest';
import { partClaims, selectionInPart } from '../src/asked-claim.js';
import { changeUri, libraryUri } from '../src/change-copies.js';
import { claimsResult } from './results.js';

describe("the claim a verify ask checks", () => {
  const result = claimsResult();
  const head = result.copies.head.commit;
  const at = (line: number, character: number) => ({ line, character });

  it("reads text selected on the head side of one of the part's files, a selection ending at a line's start ending on the line before", () => {
    const uri = changeUri('head', head, 'src/retry.py');

    expect(selectionInPart(result, 0, { uri, start: at(2, 4), end: at(4, 0), text: 'Gives up after three attempts,\n    whatever the status.\n' })).toEqual({
      path: 'src/retry.py',
      line: 3,
      endLine: 4,
      text: 'Gives up after three attempts,\n    whatever the status.\n',
    });
    expect(selectionInPart(result, 0, { uri, start: at(8, 4), end: at(8, 20), text: 'Never retries a 4xx.' })).toMatchObject({ line: 9, endLine: 9 });
  });

  it("reads no selection on the base side, at another commit, in another part's file, of a library, or holding no text", () => {
    const selected = { start: at(2, 0), end: at(2, 9), text: 'Gives up' };

    expect(selectionInPart(result, 0, { ...selected, uri: changeUri('base', result.copies.base.commit, 'src/retry.py') })).toBeUndefined();
    expect(selectionInPart(result, 0, { ...selected, uri: changeUri('head', 'f'.repeat(40), 'src/retry.py') })).toBeUndefined();
    expect(selectionInPart(result, 1, { ...selected, uri: changeUri('head', head, 'src/retry.py') })).toBeUndefined();
    const library = { library: 'httpx', pinnedVersion: '0.27.2', pinnedBy: 'requirements.txt', file: 'f', sha256: 'a'.repeat(64), archive: 'wheel' as const, path: '/cache/httpx-0.27.2-ab', promptVersion: '3', stamp: result.claims!.stamp };
    expect(selectionInPart(result, 0, { ...selected, uri: libraryUri(library, 'httpx/_client.py') })).toBeUndefined();
    expect(selectionInPart(result, 0, { ...selected, uri: changeUri('head', head, 'src/retry.py'), text: ' \n' })).toBeUndefined();
  });

  it("offers the part's own claims to pick, each with its index in the review's claims", () => {
    expect(partClaims(result, 0).map(({ index, claim }) => [index, claim.quote])).toEqual([
      [0, 'Retries failed sends.'],
      [1, 'Gives up after three attempts, whatever the status.'],
      [2, 'Never retries a 4xx.'],
    ]);
    expect(partClaims(result, 1).map(({ index }) => index)).toEqual([3]);
    expect(partClaims({ ...result, claims: undefined }, 0)).toEqual([]);
  });
});
