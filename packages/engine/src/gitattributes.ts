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
  /** The line's path pattern, without any trailing slash. */
  pattern: string;
  /** True when the pattern ended with a slash, so it names a directory tree. */
  directory: boolean;
  /** True when the pattern contains a slash and so anchors to the root. */
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
  const spaceAt = trimmed.indexOf(' ');
  if (spaceAt === -1) {
    return undefined; // A pattern with no attributes sets nothing.
  }
  return { pattern: trimmed.slice(0, spaceAt), rest: trimmed.slice(spaceAt + 1) };
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
    const bare = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (bare === '') {
      continue;
    }
    lines.push({
      pattern: bare,
      directory: pattern.endsWith('/'),
      anchored: pattern.includes('/'),
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
      source += pattern.slice(i, end + 1).replace(/\\/g, '\\\\');
      i = end;
      continue;
    }
    source += ch.replace(/[\\^$.|+(){}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Reads the linguist attributes that apply to one path from a root
 * `.gitattributes` file, as git would: later matching lines take
 * precedence, a bare attribute or `=true` sets it, `=false` clears it, and
 * a `-` prefix unsets it. Patterns without a slash match the path's
 * basename anywhere; patterns with one anchor to the repository root.
 */
export function linguistAttributesFor(path: string, source: string): LinguistAttributes {
  const states: { generated: AttributeValue; vendored: AttributeValue } = {
    generated: undefined,
    vendored: undefined,
  };
  const basename = path.split('/').pop() ?? path;
  for (const line of parseAttributeLines(source)) {
    let matches: boolean;
    if (line.directory) {
      // A trailing slash matches the directory and everything below it.
      matches = path === line.pattern || path.startsWith(`${line.pattern}/`);
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
