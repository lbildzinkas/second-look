import { PdbFormatError } from './pdb.js';

/** One Source Link entry: a path, or a path prefix when the key ends in `*`. */
export interface SourceLinkEntry {
  path: string;
  isPrefix: boolean;
  uriPrefix: string;
  uriSuffix: string;
}

function fail(message: string): never {
  throw new PdbFormatError(message);
}

/**
 * Parses Source Link JSON into its entries, longest path first, following
 * the rules of the reference implementation (dotnet/sourcelink): a path
 * may end in one `*`, and its URL may hold one `*` only when the path does.
 */
export function parseSourceLink(json: string): SourceLinkEntry[] {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`Source Link: invalid JSON (${reason})`);
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    fail('Source Link: the JSON is not an object');
  }
  const documents = (root as { documents?: unknown }).documents ?? {};
  if (typeof documents !== 'object' || documents === null || Array.isArray(documents)) {
    fail('Source Link: "documents" is not an object');
  }
  const entries: SourceLinkEntry[] = [];
  for (const [key, value] of Object.entries(documents)) {
    if (typeof value !== 'string') {
      fail(`Source Link: the URL of ${JSON.stringify(key)} is not a string`);
    }
    const star = key.indexOf('*');
    const uriStar = value.indexOf('*');
    const isPrefix = star >= 0 && star === key.length - 1;
    const isValid =
      key !== '' &&
      (star < 0 || isPrefix) &&
      (uriStar < 0 || isPrefix) &&
      value.indexOf('*', uriStar + 1) < 0;
    if (!isValid) {
      fail(`Source Link: invalid entry ${JSON.stringify(key)}`);
    }
    entries.push({
      path: isPrefix ? key.slice(0, -1) : key,
      isPrefix,
      uriPrefix: uriStar >= 0 ? value.slice(0, uriStar) : value,
      uriSuffix: uriStar >= 0 ? value.slice(uriStar + 1) : '',
    });
  }
  return entries.sort((left, right) => right.path.length - left.path.length);
}

/** Escapes one path segment as .NET's Uri.EscapeDataString does. */
function escapeDataString(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Maps a document path to its Source Link URL, or null when no entry
 * matches. Matching is case-insensitive and the most specific entry wins.
 */
export function sourceLinkUrl(entries: SourceLinkEntry[], path: string): string | null {
  if (path.includes('*')) {
    return null;
  }
  for (const entry of entries) {
    const head = path.slice(0, entry.path.length);
    if (entry.isPrefix && head.toLowerCase() === entry.path.toLowerCase()) {
      const rest = path.slice(entry.path.length).split(/[/\\]/).map(escapeDataString).join('/');
      return entry.uriPrefix + rest + entry.uriSuffix;
    }
    if (!entry.isPrefix && path.toLowerCase() === entry.path.toLowerCase()) {
      return entry.uriPrefix;
    }
  }
  return null;
}
