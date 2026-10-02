import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Parser, Tree } from '@vscode/tree-sitter-wasm';
import { pathInCopy } from './archive.js';
import { extensionOf, languageForPath } from './languages.js';
import type { LanguageSpec } from './languages.js';
import type {
  Entity,
  EntityChange,
  EntityKind,
  FormattingOnly,
  Hunk,
  Part,
  PartSyntax,
} from './protocol.js';

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
function declaredEntity(
  node: Node,
  language: LanguageSpec,
): { kind: EntityKind; name: string } | undefined {
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

/** The declaration a wrapper node holds in a child: decorators, `declare`, `export`, variables. */
function wrappedDeclaration(node: Node): Node | null | undefined {
  switch (node.type) {
    case 'decorated_definition':
      return node.childForFieldName('definition');
    case 'ambient_declaration':
    case 'lexical_declaration':
    case 'variable_declaration':
      return node.firstNamedChild;
    case 'export_statement':
      return node.childForFieldName('declaration');
    default:
      return undefined;
  }
}

/** Entity kinds whose whole declaration is their surface: their members are what callers use. */
const SURFACE_KINDS = new Set<EntityKind>(['interface', 'enum', 'struct', 'trait', 'type']);

/** Entity kinds whose nested entities are local, so never public. */
const LOCAL_SCOPES = new Set<EntityKind>(['function', 'method', 'property']);

/** One declaration enclosing a position, with the node that declares it. */
interface Declaration {
  kind: EntityKind;
  name: string;
  node: Node;
}

/** The declarations enclosing a node, outermost first, each with its own name. */
function declarationsAround(start: Node | null, language: LanguageSpec): Declaration[] {
  const chain: Declaration[] = [];
  let last: Node | undefined;
  for (let node = start; node; node = node.parent) {
    // Wrapper nodes own a declaration's first line, so hop to what they wrap.
    let target = node;
    for (let wrapped = wrappedDeclaration(target); wrapped; wrapped = wrappedDeclaration(target)) {
      target = wrapped;
    }
    if (last && target.equals(last)) continue;
    last = target;
    const entity = declaredEntity(target, language);
    if (entity) chain.unshift({ ...entity, node: target });
  }
  return chain;
}

/** The outermost wrapper around a declaration, such as its decorators or `export`. */
function outermostWrapper(declaration: Node): Node {
  let outer = declaration;
  for (let parent = outer.parent; parent; parent = parent.parent) {
    let wrapped = wrappedDeclaration(parent);
    while (wrapped && !wrapped.equals(declaration)) wrapped = wrappedDeclaration(wrapped);
    if (!wrapped) break;
    outer = parent;
  }
  return outer;
}

function hasChild(node: Node, type: string, text: RegExp): boolean {
  return node.children.some((child) => child?.type === type && text.test(child.text));
}

/** Whether a declaration's own visibility lets other modules use it. */
function isOwnPublic(
  declaration: Declaration,
  enclosing: Declaration | undefined,
  language: LanguageSpec,
): boolean {
  if (enclosing && LOCAL_SCOPES.has(enclosing.kind)) return false;
  const { node } = declaration;
  const ownName = declaration.name.slice(declaration.name.lastIndexOf('.') + 1);
  switch (language.name) {
    case 'python':
      return !ownName.startsWith('_') || /^__\w+__$/.test(ownName);
    case 'go':
      return /^\p{Lu}/u.test(ownName);
    case 'rust':
      return (
        node.type === 'impl_item' ||
        enclosing?.kind === 'trait' ||
        hasChild(node, 'visibility_modifier', /^pub$/)
      );
    case 'c-sharp':
      return enclosing?.kind === 'interface' || hasChild(node, 'modifier', /^(public|protected)$/);
    case 'java':
      return (
        enclosing?.kind === 'interface' || hasChild(node, 'modifiers', /\b(public|protected)\b/)
      );
    default: {
      // TypeScript and JavaScript: exported at the top level, not private in a class.
      if (!enclosing) {
        const outer = outermostWrapper(node);
        for (let at: Node | null = node; at; at = at.parent) {
          if (at.type === 'export_statement') return true;
          if (at.equals(outer)) break;
        }
        return false;
      }
      return (
        node.childForFieldName('name')?.type !== 'private_property_identifier' &&
        !hasChild(node, 'accessibility_modifier', /^private$/)
      );
    }
  }
}

/**
 * The rows of a declaration: from its outermost wrapper to where its body
 * opens, or all of it for a kind whose members are its surface.
 */
function declarationRows(declaration: Declaration): { first: number; last: number } {
  const { node, kind } = declaration;
  const first = outermostWrapper(node).startPosition.row;
  const body =
    node.childForFieldName('body') ??
    node.childForFieldName('accessors') ??
    node.childForFieldName('value')?.childForFieldName('body');
  if (SURFACE_KINDS.has(kind) || !body) return { first, last: node.endPosition.row };
  // A brace opens the body on its own row; an indented block starts a row later.
  const opens = body.text.startsWith('{') ? body.startPosition.row : body.startPosition.row - 1;
  return { first, last: Math.max(first, opens) };
}

/** An entity at a position, with the rows of its declaration. */
interface EntityAtPosition {
  kind: EntityKind;
  name: string;
  public: boolean;
  rows: { first: number; last: number };
}

/** The qualified name of the innermost declaration of a chain. */
function qualifiedName(chain: Declaration[]): string {
  return chain.map((declaration) => declaration.name).join('.');
}

/** The innermost entity enclosing a position, named through all enclosing entities. */
function entityAt(
  tree: Tree,
  language: LanguageSpec,
  row: number,
  column: number,
): EntityAtPosition | undefined {
  const chain = declarationsAround(tree.rootNode.descendantForPosition({ row, column }), language);
  const innermost = chain.at(-1);
  if (!innermost) return undefined;
  const outer = chain.at(-2);
  const isMethod = innermost.kind === 'function' && outer && TYPE_KINDS.has(outer.kind);
  return {
    kind: isMethod ? 'method' : innermost.kind,
    name: qualifiedName(chain),
    public: chain.every((declaration, index) =>
      isOwnPublic(declaration, chain[index - 1], language),
    ),
    rows: declarationRows(innermost),
  };
}

/** The qualified names of every entity a tree declares. */
function declaredNames(tree: Tree, language: LanguageSpec): Set<string> {
  const names = new Set<string>();
  for (const node of tree.rootNode.descendantsOfType(Object.keys(language.entities))) {
    if (node && declaredEntity(node, language)) {
      names.add(qualifiedName(declarationsAround(node, language)));
    }
  }
  return names;
}

/** One side of a file, parsed, with the names of the entities it declares. */
interface ParsedSide {
  tree: Tree;
  source: string;
  names: Set<string>;
}

/** How strongly each change marks an entity; the strongest wins across a hunk. */
const CHANGE_STRENGTH: Readonly<Record<EntityChange, number>> = {
  body: 0,
  declaration: 1,
  added: 2,
  removed: 2,
};

/**
 * The entities a hunk's changed lines fall in, in order of first
 * appearance, each with its visibility and how the hunk changes it. A
 * removed line is read from the base and an added line from the head; an
 * entity the other side does not declare is added or removed.
 */
function hunkEntities(
  hunk: Hunk,
  language: LanguageSpec,
  base?: ParsedSide,
  head?: ParsedSide,
): Entity[] {
  const entities = new Map<string, Entity>();
  for (const line of hunk.lines) {
    if (line.kind === 'context') continue;
    const [side, other] = line.kind === 'deletion' ? [base, head] : [head, base];
    const lineNumber = line.kind === 'deletion' ? line.oldLineNumber : line.newLineNumber;
    if (!side || lineNumber === undefined) continue;
    const row = lineNumber - 1;
    const column = /^[ \t]*/.exec(line.text)![0].length;
    const found = entityAt(side.tree, language, row, column);
    if (!found) continue;
    const change: EntityChange = !other?.names.has(found.name)
      ? line.kind === 'deletion'
        ? 'removed'
        : 'added'
      : row >= found.rows.first && row <= found.rows.last
        ? 'declaration'
        : 'body';
    const key = `${found.kind} ${found.name}`;
    const seen = entities.get(key);
    if (seen && CHANGE_STRENGTH[seen.change] >= CHANGE_STRENGTH[change]) continue;
    entities.set(key, { kind: found.kind, name: found.name, public: found.public, change });
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
    return tree && source !== undefined
      ? { tree, source, names: declaredNames(tree, language) }
      : undefined;
  };
  const started = performance.now();
  const base = parse(versions.base);
  const head = parse(versions.head);
  const parseTimeMs = performance.now() - started;
  try {
    for (const hunk of part.hunks) {
      hunk.entities = hunkEntities(hunk, language, base, head);
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
