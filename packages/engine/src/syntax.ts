import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Parser, Tree } from '@vscode/tree-sitter-wasm';
import { pathInCopy } from './archive.js';
import { extensionOf, languageForPath } from './languages.js';
import type { LanguageSpec } from './languages.js';
import type { Entity, EntityKind, FormattingOnly, Hunk, Part, PartSyntax } from './protocol.js';

/** Files larger than this are not parsed; their checks say so. */
const MAX_PARSE_BYTES = 1_000_000;

/** Entity kinds whose functions are methods. */
const TYPE_KINDS = new Set<EntityKind>(['class', 'struct', 'interface', 'enum', 'trait', 'impl']);

/** Values that make a variable declarator a named function. */
const FUNCTION_VALUES = new Set([
  'arrow_function',
  'function',
  'function_expression',
  'generator_function',
]);

const require = createRequire(import.meta.url);
let runtime: Promise<void> | undefined;
const parsers = new Map<string, Promise<Parser>>();

/** One parser per language, loading the runtime and the WASM grammar once. */
function parserFor(language: LanguageSpec): Promise<Parser> {
  let parser = parsers.get(language.name);
  if (!parser) {
    parser = (async () => {
      runtime ??= treeSitter.Parser.init();
      await runtime;
      const grammar = await readFile(
        require.resolve(`@vscode/tree-sitter-wasm/wasm/${language.grammar}`),
      );
      const created = new treeSitter.Parser();
      created.setLanguage(await treeSitter.Language.load(grammar));
      return created;
    })();
    parsers.set(language.name, parser);
  }
  return parser;
}

/** A file's content on each side of the change; undefined where the side has no file. */
export interface FileVersions {
  base?: string;
  head?: string;
}

function nothingChecked(language: string | undefined, reason: string): PartSyntax {
  return {
    language,
    formattingOnly: { status: 'not-checked', reason },
    checksNotRun: [
      { check: 'entities', reason },
      { check: 'formatting-only', reason },
    ],
  };
}

/** The first line where a side's copy disagrees with the diff, if any. */
function mismatchWithDiff(part: Part, versions: FileVersions): string | undefined {
  const base = versions.base?.split('\n');
  const head = versions.head?.split('\n');
  for (const hunk of part.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== 'addition' && base && base[line.oldLineNumber! - 1] !== line.text) {
        return `the base copy does not match the diff at line ${line.oldLineNumber}`;
      }
      if (line.kind !== 'deletion' && head && head[line.newLineNumber! - 1] !== line.text) {
        return `the head copy does not match the diff at line ${line.newLineNumber}`;
      }
    }
  }
  return undefined;
}

/** The entity a node declares, with its name, or undefined when it declares none. */
function declaredEntity(node: Node, language: LanguageSpec): Entity | undefined {
  let kind = language.entities[node.type];
  if (kind === undefined) return undefined;
  let name = node.childForFieldName('name')?.text;
  if (node.type === 'variable_declarator') {
    const value = node.childForFieldName('value');
    if (!value || !FUNCTION_VALUES.has(value.type)) return undefined;
  } else if (node.type === 'impl_item') {
    const type = node.childForFieldName('type');
    name = (type?.childForFieldName('type') ?? type)?.text;
  } else if (node.type === 'type_spec') {
    const type = node.childForFieldName('type')?.type;
    kind = type === 'struct_type' ? 'struct' : type === 'interface_type' ? 'interface' : 'type';
  }
  // A Go method is named after its receiver's type, which it sits outside of.
  const receiver = node.childForFieldName('receiver');
  const receiverType = receiver?.descendantsOfType('type_identifier')[0]?.text;
  if (name && receiverType) name = `${receiverType}.${name}`;
  return name ? { kind, name } : undefined;
}

/** The innermost entity enclosing a position, named through all enclosing entities. */
function entityAt(
  tree: Tree,
  language: LanguageSpec,
  row: number,
  column: number,
): Entity | undefined {
  const chain: Entity[] = [];
  let last: Node | undefined;
  for (let node = tree.rootNode.descendantForPosition({ row, column }); node; node = node.parent) {
    // A decorated Python definition owns its decorator lines.
    const target =
      node.type === 'decorated_definition'
        ? node.childForFieldName('definition')
        : node.type === 'ambient_declaration'
          ? node.firstNamedChild
          : node;
    if (!target || (last && target.equals(last))) continue;
    last = target;
    const entity = declaredEntity(target, language);
    if (entity) chain.unshift(entity);
  }
  const innermost = chain.at(-1);
  if (!innermost) return undefined;
  const outer = chain.at(-2);
  const isMethod = innermost.kind === 'function' && outer && TYPE_KINDS.has(outer.kind);
  const kind = isMethod ? 'method' : innermost.kind;
  return { kind, name: chain.map((entity) => entity.name).join('.') };
}

/** The entities a hunk's changed lines fall in, in order of first appearance. */
function hunkEntities(hunk: Hunk, language: LanguageSpec, base?: Tree, head?: Tree): Entity[] {
  const entities = new Map<string, Entity>();
  for (const line of hunk.lines) {
    const tree = line.kind === 'deletion' ? base : line.kind === 'addition' ? head : undefined;
    const lineNumber = line.kind === 'deletion' ? line.oldLineNumber : line.newLineNumber;
    if (!tree || lineNumber === undefined) continue;
    const column = /^[ \t]*/.exec(line.text)![0].length;
    const entity = entityAt(tree, language, lineNumber - 1, column);
    if (entity) entities.set(`${entity.kind} ${entity.name}`, entity);
  }
  return [...entities.values()];
}

const CLOSE = ')';

/** Node types whose whitespace is content rather than formatting. */
const STRING_LIKE = /string|template|heredoc|literal|regex|comment/;

/** Interpolation wrappers inside them hold code, so their whitespace is formatting. */
const INTERPOLATION = /substitution|interpolation|template_type/;

interface SignatureToken {
  text: string;
  row: number;
}

/**
 * The structural signature of a tree: every node's type with explicit open
 * and close marks, so nesting is part of the signature, plus every token's
 * text verbatim. Whitespace between tokens is left out, so formatting does
 * not change the signature; an indentation change that moves a statement
 * into or out of a block changes the nesting and does.
 *
 * Open marks start with `(`, close marks are `)` and text starts with `'`,
 * so no token's text can pass for structure. The walk keeps its own stack,
 * so deeply nested code cannot exhaust the call stack.
 */
function* signature(tree: Tree, source: string): Generator<SignatureToken> {
  const cursor = tree.walk();
  // The nodes entered and not yet closed, with where their last child ended.
  const open: { end: number; row: number; keep: RegExp; previousEnd: number }[] = [];
  try {
    for (;;) {
      const row = cursor.startPosition.row;
      const start = cursor.startIndex;
      const end = cursor.endIndex;
      const parent = open.at(-1);
      if (parent) {
        // Text between children that is not whitespace belongs to the parent
        // token itself and is kept verbatim; inside strings and the like, so
        // is whitespace.
        const gap = source.slice(parent.previousEnd, start);
        if (parent.keep.test(gap)) yield { text: `'${gap}`, row };
        parent.previousEnd = end;
      }
      const type = cursor.nodeType;
      yield { text: `(${type}`, row };
      if (cursor.gotoFirstChild()) {
        open.push({
          end,
          row,
          keep: STRING_LIKE.test(type) && !INTERPOLATION.test(type) ? /[^]/ : /\S/,
          previousEnd: start,
        });
        continue;
      }
      yield { text: `'${source.slice(start, end)}`, row };
      yield { text: CLOSE, row };
      // Close every node whose last child is done, then go on to the next sibling.
      while (!cursor.gotoNextSibling()) {
        const done = open.pop();
        if (!done) return;
        cursor.gotoParent();
        const tail = source.slice(done.previousEnd, done.end);
        if (done.keep.test(tail)) yield { text: `'${tail}`, row: done.row };
        yield { text: CLOSE, row: done.row };
      }
    }
  } finally {
    cursor.delete();
  }
}

/** Compares two signatures; returns the first head row where they differ, or undefined. */
function firstStructuralDifference(base: ParsedSide, head: ParsedSide): number | undefined {
  const baseTokens = signature(base.tree, base.source);
  const headTokens = signature(head.tree, head.source);
  try {
    for (;;) {
      const a = baseTokens.next();
      const b = headTokens.next();
      if (a.done && b.done) return undefined;
      if (a.done || b.done || a.value.text !== b.value.text) {
        // Report where the head goes on, past blocks that closed early.
        let at = b;
        while (!at.done && at.value.text === CLOSE) at = headTokens.next();
        return at.done ? head.tree.rootNode.endPosition.row : at.value.row;
      }
    }
  } finally {
    baseTokens.return(undefined);
    headTokens.return(undefined);
  }
}

/** One side of a file, parsed. */
interface ParsedSide {
  tree: Tree;
  source: string;
}

function formattingOnly(part: Part, base?: ParsedSide, head?: ParsedSide): FormattingOnly {
  if (part.hunks.length === 0) {
    return { status: 'not-checked', reason: 'the content did not change' };
  }
  if (part.changeKind === 'addition') {
    return { status: 'structure-changed', reason: 'the file is new' };
  }
  if (part.changeKind === 'deletion') {
    return { status: 'structure-changed', reason: 'the file is deleted' };
  }
  if (!base || !head) {
    return { status: 'not-checked', reason: 'a side of the file was not parsed' };
  }
  for (const [side, { tree }] of [
    ['base', base],
    ['head', head],
  ] as const) {
    if (tree.rootNode.hasError) {
      return {
        status: 'not-checked',
        reason: `the ${side} version has syntax errors, so its structure cannot be compared`,
      };
    }
  }
  const row = firstStructuralDifference(base, head);
  if (row === undefined) {
    return {
      status: 'confirmed',
      reason: 'base and head have the same syntax tree, nesting included; only formatting changed',
    };
  }
  return { status: 'structure-changed', reason: `the syntax tree changes at head line ${row + 1}` };
}

/**
 * Runs the syntax pass on one part: parses each side with its language's
 * grammar, names the entities each hunk touches, and checks whether the
 * change is formatting-only. Sets `part.syntax` and every hunk's
 * `entities`, and returns the milliseconds spent parsing. A file with no
 * grammar, or whose copies cannot be read, still flows through: its
 * syntax says which checks did not run and why.
 */
export async function analysePart(
  part: Part,
  versions: FileVersions,
): Promise<{ parseTimeMs: number }> {
  const language = languageForPath(part.path);
  const fail = (reason: string): { parseTimeMs: number } => {
    part.syntax = nothingChecked(language?.name, reason);
    return { parseTimeMs: 0 };
  };

  if (part.isBinary) return fail('the file is binary');
  if (!language) {
    const extension = extensionOf(part.path);
    const files = extension === '' ? 'files without an extension' : `"${extension}" files`;
    return fail(`no grammar for ${files}, so its hunks are read at file level`);
  }
  for (const side of ['base', 'head'] as const) {
    const absentKind = side === 'base' ? 'addition' : 'deletion';
    const needed = part.changeKind !== absentKind;
    const source = versions[side];
    if (needed && source === undefined) {
      return fail(`the ${side} copy has no such file; archives leave out export-ignore paths`);
    }
    if (source !== undefined && Buffer.byteLength(source) > MAX_PARSE_BYTES) {
      return fail(
        `the ${side} version is larger than ${MAX_PARSE_BYTES} bytes, so it was not parsed`,
      );
    }
  }
  const mismatch = mismatchWithDiff(part, versions);
  if (mismatch) return fail(mismatch);

  const parser = await parserFor(language);
  const parse = (source: string | undefined): ParsedSide | undefined => {
    const tree = source === undefined ? null : parser.parse(source);
    return tree && source !== undefined ? { tree, source } : undefined;
  };
  const started = performance.now();
  const base = parse(versions.base);
  const head = parse(versions.head);
  const parseTimeMs = performance.now() - started;
  try {
    for (const hunk of part.hunks) {
      hunk.entities = hunkEntities(hunk, language, base?.tree, head?.tree);
    }
    const formatting = formattingOnly(part, base, head);
    part.syntax = {
      language: language.name,
      formattingOnly: formatting,
      checksNotRun:
        formatting.status === 'not-checked'
          ? [{ check: 'formatting-only', reason: formatting.reason }]
          : [],
    };
    return { parseTimeMs };
  } finally {
    base?.tree.delete();
    head?.tree.delete();
  }
}

/** Reads one file of a copy, or undefined when the copy has no such file. */
async function readCopyFile(copyDir: string, path: string): Promise<string | undefined> {
  const absolute = pathInCopy(copyDir, path);
  if (absolute === undefined) return undefined;
  try {
    return await readFile(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Runs the syntax pass on every part, reading each file from the base
 * copy (under its previous path) and the head copy. Returns the total time
 * spent parsing, in milliseconds.
 */
export async function analyseParts(
  parts: Part[],
  copies: { base: string; head: string },
): Promise<{ parseTimeMs: number }> {
  let parseTimeMs = 0;
  for (const part of parts) {
    const versions: FileVersions = {
      base:
        part.changeKind === 'addition'
          ? undefined
          : await readCopyFile(copies.base, part.previousPath ?? part.path),
      head: part.changeKind === 'deletion' ? undefined : await readCopyFile(copies.head, part.path),
    };
    parseTimeMs += (await analysePart(part, versions)).parseTimeMs;
  }
  return { parseTimeMs: Math.round(parseTimeMs * 1000) / 1000 };
}
