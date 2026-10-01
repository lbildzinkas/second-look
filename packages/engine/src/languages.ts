import type { EntityKind } from './protocol.js';

/**
 * One language the syntax pass understands: the tree-sitter grammar that
 * parses it, bundled as WASM, and the node types that are named entities.
 * Every other language still flows through the review and is read at file
 * level (ADR 0001).
 */
export interface LanguageSpec {
  /** Name reported in the result. */
  name: string;
  /** The grammar's WASM file in `@vscode/tree-sitter-wasm`. */
  grammar: string;
  /** File extensions, lower case, with their leading dot. */
  extensions: readonly string[];
  /** Node types that declare an entity, with the entity's kind. */
  entities: Readonly<Record<string, EntityKind>>;
}

const TYPESCRIPT_ENTITIES: Readonly<Record<string, EntityKind>> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  variable_declarator: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  class: 'class',
  method_definition: 'method',
  method_signature: 'method',
  abstract_method_signature: 'method',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  type_alias_declaration: 'type',
};

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    name: 'python',
    grammar: 'tree-sitter-python.wasm',
    extensions: ['.py', '.pyi'],
    entities: {
      function_definition: 'function',
      class_definition: 'class',
    },
  },
  {
    name: 'c-sharp',
    grammar: 'tree-sitter-c-sharp.wasm',
    extensions: ['.cs', '.csx'],
    entities: {
      class_declaration: 'class',
      record_declaration: 'class',
      struct_declaration: 'struct',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      method_declaration: 'method',
      constructor_declaration: 'method',
      destructor_declaration: 'method',
      local_function_statement: 'function',
      property_declaration: 'property',
    },
  },
  {
    name: 'typescript',
    grammar: 'tree-sitter-typescript.wasm',
    extensions: ['.ts', '.mts', '.cts'],
    entities: TYPESCRIPT_ENTITIES,
  },
  {
    name: 'tsx',
    grammar: 'tree-sitter-tsx.wasm',
    extensions: ['.tsx'],
    entities: TYPESCRIPT_ENTITIES,
  },
  {
    name: 'javascript',
    grammar: 'tree-sitter-javascript.wasm',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    entities: TYPESCRIPT_ENTITIES,
  },
  {
    name: 'go',
    grammar: 'tree-sitter-go.wasm',
    extensions: ['.go'],
    entities: {
      function_declaration: 'function',
      method_declaration: 'method',
      type_spec: 'type',
    },
  },
  {
    name: 'rust',
    grammar: 'tree-sitter-rust.wasm',
    extensions: ['.rs'],
    entities: {
      function_item: 'function',
      function_signature_item: 'function',
      struct_item: 'struct',
      union_item: 'struct',
      enum_item: 'enum',
      trait_item: 'trait',
      impl_item: 'impl',
    },
  },
  {
    name: 'java',
    grammar: 'tree-sitter-java.wasm',
    extensions: ['.java'],
    entities: {
      class_declaration: 'class',
      record_declaration: 'class',
      interface_declaration: 'interface',
      annotation_type_declaration: 'interface',
      enum_declaration: 'enum',
      method_declaration: 'method',
      constructor_declaration: 'method',
      compact_constructor_declaration: 'method',
    },
  },
];

/** The file's extension, lower case with its dot, or '' when it has none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** The language whose grammar parses this path, if any. */
export function languageForPath(path: string): LanguageSpec | undefined {
  const extension = extensionOf(path);
  return LANGUAGES.find((language) => language.extensions.includes(extension));
}
