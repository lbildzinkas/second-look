import { decodePathToken } from './diff.js';

/**
 * The linguist attributes GitHub's own classifier honours, as declared by
 * the repository's `.gitattributes`: `linguist-generated` and
 * `linguist-vendored`.
 */
export interface LinguistAttributes {
  /** True when the path is declared generated. */
  generated: boolean;
  /** True when the path is declared vendored. */
  vendored: boolean;
}

/** One parsed line of a `.gitattributes` file. */
interface AttributeLine {
  /** The line's path pattern, without any trailing slash or leading anchor slash. */
  pattern: string;
  /** True when the pattern ended with a slash, so it names a directory tree. */
  directory: boolean;
  /** True when a leading or interior slash anchors the pattern to the root. */
  anchored: boolean;
  /** Values of the two attributes this reader cares about, when set. */
  values: Partial<Record<'generated' | 'vendored', boolean | 'unset'>>;
}

/** How one attribute token reads: set, cleared, or unset. */
type AttributeValue = boolean | 'unset' | undefined;

/** The two attributes this reader honours, by their full git spellings. */
type LinguistAttributeName = 'linguist-generated' | 'linguist-vendored';

/**
 * Splits one `.gitattributes` line into its pattern token and attribute
 * tokens. The pattern may be C-quoted; attributes are whitespace-separated.
 */
function splitAttributeLine(line: string): { pattern: string; rest: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.startsWith('"')) {
    let end = -1;
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        end = i;
        break;
      }
    }
    if (end === -1) {
      return undefined;
    }
    return { pattern: trimmed.slice(0, end + 1), rest: trimmed.slice(end + 1) };
  }
  const wsAt = trimmed.search(/\s/);
  if (wsAt === -1) {
    return undefined; // A pattern with no attributes sets nothing.
  }
  return { pattern: trimmed.slice(0, wsAt), rest: trimmed.slice(wsAt + 1) };
}

/** Reads one attribute token: bare or `=true` sets, `=false` clears. */
function readAttributeToken(
  token: string,
  name: LinguistAttributeName,
): AttributeValue {
  if (token === name) {
    return true; // A bare attribute means true.
  }
  const assignment = `${name}=`;
  if (token.startsWith(assignment)) {
    const value = token.slice(assignment.length);
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  }
  return undefined; // Custom string values are not booleans.
}

/** Parses the whole `.gitattributes` text into the lines this reader keeps. */
function parseAttributeLines(source: string): AttributeLine[] {
  const lines: AttributeLine[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) {
      // Comment, blank, or a gitignore-style negation, which gitattributes
      // does not support.
      continue;
    }
    const split = splitAttributeLine(rawLine);
    if (split === undefined) {
      continue;
    }
    const pattern = decodePathToken(split.pattern);
    if (pattern === undefined || pattern === '') {
      continue;
    }
    const values: AttributeLine['values'] = {};
    for (const token of split.rest.split(/\s+/)) {
      if (token === '') {
        continue;
      }
      const unset = token.startsWith('-');
      const attribute = (unset ? token.slice(1) : token.split('=')[0]!) as LinguistAttributeName;
      if (attribute !== 'linguist-generated' && attribute !== 'linguist-vendored') {
        continue;
      }
      const value: AttributeValue = unset ? 'unset' : readAttributeToken(token, attribute);
      if (value !== undefined) {
        if (attribute === 'linguist-generated') {
          values.generated = value;
        } else {
          values.vendored = value;
        }
      }
    }
    if (values.generated === undefined && values.vendored === undefined) {
      continue;
    }
    const directory = pattern.endsWith('/');
    let body = directory ? pattern.slice(0, -1) : pattern;
    const anchored = body.startsWith('/') || body.includes('/');
    if (body.startsWith('/')) {
      body = body.slice(1); // A leading slash anchors; it is not matched.
    }
    if (body === '') {
      continue;
    }
    lines.push({
      pattern: body,
      directory,
      anchored,
      values,
    });
  }
  return lines;
}

/**
 * Translates one gitignore-style pattern into a regular expression over a
 * single path: `*` and `?` stay within one directory, `**` crosses them,
 * `[...]` is a character class, and every other character is literal.
 */
function patternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0;
        const precededBySlash = i > 0 && pattern[i - 1] === '/';
        const atEnd = i + 2 === pattern.length;
        const followedBySlash = pattern[i + 2] === '/';
        // `**` crosses directories only as a whole path component, exactly
        // as git's wildmatch reads it; anywhere else it is a plain `*`.
        const special = (atStart || precededBySlash) && (atEnd || followedBySlash);
        if (special && followedBySlash) {
          // `**/` matches zero or more whole directories before what follows.
          source += '(?:[^/]+/)*';
          i += 2;
        } else if (special) {
          // A trailing `**` matches everything below; at the very start,
          // everything at all.
          source += '.*';
          i += 1;
        } else {
          source += '[^/]*';
          i += 1;
        }
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      const cls = pattern.slice(i, end + 1);
      // Wildmatch negates a class with '!', not '^'.
      const negated = cls.startsWith('[!') ? `[^${cls.slice(2)}` : cls;
      source += negated.replace(/\\/g, '\\\\');
      i = end;
      continue;
    }
    source += ch.replace(/[\\^$.|+(){}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** The final path segment: what a slash-free pattern matches. */
function basenameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Every directory prefix of a path: for a/b/file.ts, a and a/b. */
function directoryPrefixes(path: string): string[] {
  const segments = path.split('/');
  const prefixes: string[] = [];
  for (let count = 1; count < segments.length; count++) {
    prefixes.push(segments.slice(0, count).join('/'));
  }
  return prefixes;
}

/**
 * Reads the linguist attributes that apply to one path from a root
 * `.gitattributes` file, as git would: later matching lines take
 * precedence, a bare attribute or `=true` sets it, `=false` clears it, and
 * a `-` prefix unsets it. Patterns without a slash match the path's
 * basename anywhere; a leading or interior slash anchors the pattern to
 * the repository root; a trailing slash matches the directory tree and
 * everything below it.
 */
export function linguistAttributesFor(path: string, source: string): LinguistAttributes {
  const states: { generated: AttributeValue; vendored: AttributeValue } = {
    generated: undefined,
    vendored: undefined,
  };
  const basename = basenameOf(path);
  for (const line of parseAttributeLines(source)) {
    let matches: boolean;
    if (line.directory) {
      // A trailing slash matches the directory and so everything below
      // it: every directory prefix of the path is tested the same way a
      // pattern without one tests the path itself.
      matches = directoryPrefixes(path).some(
        (prefix) => patternToRegExp(line.pattern).test(line.anchored ? prefix : basenameOf(prefix)),
      );
    } else {
      const subject = line.anchored ? path : basename;
      matches = patternToRegExp(line.pattern).test(subject);
    }
    if (!matches) {
      continue;
    }
    // Later matching lines take precedence, exactly as git reads them.
    if (line.values.generated !== undefined) {
      states.generated = line.values.generated === 'unset' ? undefined : line.values.generated;
    }
    if (line.values.vendored !== undefined) {
      states.vendored = line.values.vendored === 'unset' ? undefined : line.values.vendored;
    }
  }
  return { generated: states.generated === true, vendored: states.vendored === true };
}
