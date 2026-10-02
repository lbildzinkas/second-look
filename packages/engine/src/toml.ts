/**
 * A minimal TOML reader for the lock files and manifests the noise rules
 * read: uv.lock, poetry.lock, Cargo.lock, pyproject.toml and Cargo.toml
 * (ADR 0005 keeps the engine dependency-light, so the subset these files
 * use — tables, arrays of tables, strings, numbers, booleans, arrays and
 * inline tables — is parsed here rather than by a library). Anything the
 * reader does not recognise makes the whole document unreadable: callers
 * treat that as a check that could not run, never as a guess.
 */

/** A TOML value as this reader represents it: a plain structure. */
export type TomlValue = string | number | boolean | TomlTable | TomlValue[];

/** A TOML table, as a plain object with string keys. */
export interface TomlTable {
  [key: string]: TomlValue;
}

/** Thrown internally on any input the reader does not recognise. */
class TomlError extends Error {}

/** Fails the parse: the document is outside the supported subset. */
function fail(): never {
  throw new TomlError();
}

export function isTomlTable(value: unknown): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hexDigit(char: string | undefined): number | undefined {
  if (char === undefined) return undefined;
  if (char >= '0' && char <= '9') return Number(char);
  if (char >= 'a' && char <= 'f') return char.charCodeAt(0) - 87;
  if (char >= 'A' && char <= 'F') return char.charCodeAt(0) - 55;
  return undefined;
}

function isKeyChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_' ||
    char === '-'
  );
}

/**
 * Reads a TOML document into plain tables and arrays. Undefined when any
 * part of the document is outside the supported subset, so no caller ever
 * reads a half-parsed lock file.
 */
export function parseToml(text: string): TomlTable | undefined {
  const root: TomlTable = {};
  let at = 0;
  /** The table path the current section's assignments land in. */
  let section: string[] = [];

  const skipInline = (): void => {
    while (text[at] === ' ' || text[at] === '\t') at++;
  };

  /** Whitespace, newlines and whole-line comments between statements. */
  const skipBlanks = (): void => {
    for (;;) {
      const char = text[at];
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        at++;
        continue;
      }
      if (char === '#') {
        while (at < text.length && text[at] !== '\n') at++;
        continue;
      }
      return;
    }
  };

  /** Consumes trailing whitespace and comment; must reach a line break. */
  const endLine = (): void => {
    skipInline();
    if (text[at] === '#') {
      while (at < text.length && text[at] !== '\n') at++;
    }
    if (at < text.length && text[at] !== '\n' && text[at] !== '\r') fail();
  };

  const parseEscape = (): string => {
    at++; // past the backslash
    const simple: Readonly<Record<string, string>> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      '"': '"',
      '\\': '\\',
    };
    const char = text[at];
    if (char === undefined) fail();
    const escaped = simple[char];
    if (escaped !== undefined) {
      at++;
      return escaped;
    }
    if (char === 'u' || char === 'U') {
      const width = char === 'u' ? 4 : 8;
      at++;
      let code = 0;
      for (let digit = 0; digit < width; digit++) {
        const value = hexDigit(text[at]);
        if (value === undefined) fail();
        code = code * 16 + value;
        at++;
      }
      if (code > 0x10ffff) fail();
      return String.fromCodePoint(code);
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      // A line-ending backslash in a multi-line string swallows the blanks.
      while (at < text.length && /\s/.test(text[at]!)) at++;
      return '';
    }
    fail();
  };

  const parseBasicString = (): string => {
    if (text.startsWith('"""', at)) {
      at += 3;
      if (text[at] === '\r' && text[at + 1] === '\n') at += 2;
      else if (text[at] === '\n') at++;
      let out = '';
      for (;;) {
        if (text.startsWith('"""', at)) {
          at += 3;
          return out;
        }
        if (at >= text.length) fail();
        if (text[at] === '\\') {
          out += parseEscape();
          continue;
        }
        out += text[at]!;
        at++;
      }
    }
    at++; // past the opening quote
    let out = '';
    for (;;) {
      const char = text[at];
      if (char === undefined || char === '\n') fail();
      if (char === '"') {
        at++;
        return out;
      }
      if (char === '\\') {
        out += parseEscape();
        continue;
      }
      out += char;
      at++;
    }
  };

  const parseLiteralString = (): string => {
    if (text.startsWith("'''", at)) {
      at += 3;
      if (text[at] === '\n') at++;
      const end = text.indexOf("'''", at);
      if (end < 0) fail();
      const out = text.slice(at, end);
      at = end + 3;
      return out;
    }
    at++; // past the opening quote
    const end = text.indexOf("'", at);
    if (end < 0 || text.slice(at, end).includes('\n')) fail();
    const out = text.slice(at, end);
    at = end + 1;
    return out;
  };

  const parseKey = (): string => {
    const char = text[at];
    if (char === '"') return parseBasicString();
    if (char === "'") return parseLiteralString();
    const start = at;
    while (at < text.length && isKeyChar(text[at]!)) at++;
    if (at === start) fail();
    return text.slice(start, at);
  };

  const parseKeyPath = (): string[] => {
    const path = [parseKey()];
    for (;;) {
      skipInline();
      if (text[at] !== '.') return path;
      at++;
      skipInline();
      path.push(parseKey());
    }
  };

  /** Steps into a table, creating it, or an array of tables' last member. */
  const descend = (table: TomlTable, key: string): TomlTable => {
    const existing = table[key];
    if (existing === undefined) {
      const next: TomlTable = {};
      table[key] = next;
      return next;
    }
    if (isTomlTable(existing)) return existing;
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (isTomlTable(last)) return last;
    }
    fail();
  };

  const parseArray = (): TomlValue[] => {
    at++; // past [
    const items: TomlValue[] = [];
    for (;;) {
      skipBlanks();
      if (text[at] === ']') {
        at++;
        return items;
      }
      items.push(parseValue());
      skipBlanks();
      if (text[at] === ',') {
        at++;
        continue;
      }
      if (text[at] === ']') {
        at++;
        return items;
      }
      fail();
    }
  };

  const parseInlineTable = (): TomlTable => {
    at++; // past {
    const table: TomlTable = {};
    skipInline();
    if (text[at] === '}') {
      at++;
      return table;
    }
    for (;;) {
      const path = parseKeyPath();
      skipInline();
      if (text[at] !== '=') fail();
      at++;
      skipInline();
      const value = parseValue();
      const target = path.slice(0, -1).reduce(descend, table);
      const last = path[path.length - 1]!;
      if (target[last] !== undefined) fail();
      target[last] = value;
      skipInline();
      if (text[at] === ',') {
        at++;
        skipInline();
        continue;
      }
      if (text[at] === '}') {
        at++;
        return table;
      }
      fail();
    }
  };

  const parseNumber = (): number => {
    const start = at;
    if (text[at] === '+' || text[at] === '-') at++;
    if (text.startsWith('0x', at)) {
      at += 2;
      const digits = at;
      while (hexDigit(text[at]) !== undefined || text[at] === '_') at++;
      const raw = text.slice(digits, at).replaceAll('_', '');
      if (raw.length === 0) fail();
      return parseInt(raw, 16);
    }
    let end = at;
    while ((text[at]! >= '0' && text[at]! <= '9') || text[at] === '_') at++;
    end = at;
    if (text[at] === '.') {
      at++;
      while ((text[at]! >= '0' && text[at]! <= '9') || text[at] === '_') at++;
      end = at;
    }
    if (text[at] === 'e' || text[at] === 'E') {
      at++;
      if (text[at] === '+' || text[at] === '-') at++;
      const digits = at;
      while ((text[at]! >= '0' && text[at]! <= '9') || text[at] === '_') at++;
      if (at === digits) fail();
      end = at;
    }
    const raw = text.slice(start, end).replaceAll('_', '');
    if (!/^[+-]?\d/.test(raw)) fail();
    const value = Number(raw);
    if (!Number.isFinite(value)) fail();
    return value;
  };

  function parseValue(): TomlValue {
    const char = text[at];
    if (char === '"') return parseBasicString();
    if (char === "'") return parseLiteralString();
    if (char === '[') return parseArray();
    if (char === '{') return parseInlineTable();
    if (text.startsWith('true', at)) {
      at += 4;
      return true;
    }
    if (text.startsWith('false', at)) {
      at += 5;
      return false;
    }
    return parseNumber();
  }

  const setValue = (path: string[], value: TomlValue): void => {
    let table = root;
    for (const key of section) table = descend(table, key);
    const target = path.slice(0, -1).reduce(descend, table);
    const last = path[path.length - 1]!;
    if (target[last] !== undefined) fail();
    target[last] = value;
  };

  try {
    for (;;) {
      skipBlanks();
      if (at >= text.length) return root;
      if (text[at] === '[') {
        const arrayOfTables = text[at + 1] === '[';
        at += arrayOfTables ? 2 : 1;
        skipInline();
        const path = parseKeyPath();
        skipInline();
        if (arrayOfTables) {
          if (!text.startsWith(']]', at)) fail();
          at += 2;
        } else {
          if (text[at] !== ']') fail();
          at++;
        }
        endLine();
        if (arrayOfTables) {
          const parent = path.slice(0, -1).reduce(descend, root);
          const last = path[path.length - 1]!;
          const existing = parent[last];
          const array: TomlValue[] =
            existing === undefined
              ? ((parent[last] = []), parent[last] as TomlValue[])
              : Array.isArray(existing)
                ? existing
                : fail();
          array.push({});
        }
        section = path;
        continue;
      }
      const path = parseKeyPath();
      skipInline();
      if (text[at] !== '=') fail();
      at++;
      skipInline();
      const value = parseValue();
      endLine();
      setValue(path, value);
    }
  } catch (error) {
    if (error instanceof TomlError) return undefined;
    throw error;
  }
}
