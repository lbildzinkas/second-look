import { describe, expect, it } from 'vitest';
import { languageForPath } from '../src/languages.js';
import { analysePart } from '../src/syntax.js';
import { changedPart } from './helpers.js';

const PYTHON_BEFORE_REFORMAT = `import os


def load( path ,mode='r' ):
    with open(path,mode) as handle:
        return handle.read( )


class Store :
    def path_for(self,name):
        return os.path.join( self.root,
                             name )
`;

const PYTHON_AFTER_REFORMAT = `import os


def load(path, mode='r'):
    with open(path, mode) as handle:
        return handle.read()


class Store:
    def path_for(self, name):
        return os.path.join(self.root, name)
`;

const PYTHON_BEFORE_DEDENT = `def apply_discount(order):
    if order.total > 100:
        order.total -= 10
        order.flag = True
    return order
`;

const PYTHON_AFTER_DEDENT = `def apply_discount(order):
    if order.total > 100:
        order.total -= 10
    order.flag = True
    return order
`;

const CSHARP_ALLMAN = `namespace Demo;

public class Greeter
{
    public string Greet(string name)
    {
        return "Hello, " + name;
    }
}
`;

const CSHARP_KR = `namespace Demo;

public class Greeter {
  public string Greet(string name) {
    return "Hello, " + name;
  }
}
`;

describe('formatting-only check', () => {
  it('confirms a pure Python reformat', async () => {
    const part = changedPart({
      path: 'app/reformat.py',
      base: PYTHON_BEFORE_REFORMAT,
      head: PYTHON_AFTER_REFORMAT,
      deleted: [4, 5, 6, 9, 10, 11, 12],
      added: [4, 5, 6, 9, 10, 11],
    });
    await analysePart(part, { base: PYTHON_BEFORE_REFORMAT, head: PYTHON_AFTER_REFORMAT });
    expect(part.syntax.language).toBe('python');
    expect(part.syntax.formattingOnly.status).toBe('confirmed');
    expect(part.syntax.checksNotRun).toEqual([]);
  });

  it('refuses a Python dedent that moves a statement out of its block', async () => {
    // Without whitespace both versions read the same; only the nesting differs.
    const squash = (text: string): string => text.replace(/\s+/g, '');
    expect(squash(PYTHON_BEFORE_DEDENT)).toBe(squash(PYTHON_AFTER_DEDENT));

    const part = changedPart({
      path: 'app/dedent.py',
      base: PYTHON_BEFORE_DEDENT,
      head: PYTHON_AFTER_DEDENT,
      deleted: [4],
      added: [4],
    });
    await analysePart(part, { base: PYTHON_BEFORE_DEDENT, head: PYTHON_AFTER_DEDENT });
    expect(part.syntax.formattingOnly.status).toBe('structure-changed');
    expect(part.syntax.formattingOnly.reason).toBe('the syntax tree changes at head line 4');
    expect(part.hunks[0]!.entities).toEqual([{ kind: 'function', name: 'apply_discount' }]);
  });

  it('confirms a C# whitespace-only change', async () => {
    const part = changedPart({
      path: 'src/Greeter.cs',
      base: CSHARP_ALLMAN,
      head: CSHARP_KR,
      deleted: [3, 4, 5, 6, 7, 8],
      added: [3, 4, 5, 6],
    });
    await analysePart(part, { base: CSHARP_ALLMAN, head: CSHARP_KR });
    expect(part.syntax.language).toBe('c-sharp');
    expect(part.syntax.formattingOnly.status).toBe('confirmed');
    expect(part.hunks[0]!.entities).toEqual([
      { kind: 'class', name: 'Greeter' },
      { kind: 'method', name: 'Greeter.Greet' },
    ]);
  });

  it('refuses a change inside a string literal, even one of whitespace', async () => {
    const head = CSHARP_ALLMAN.replace('"Hello, "', '"Hello,  "');
    const part = changedPart({
      path: 'src/Greeter.cs',
      base: CSHARP_ALLMAN,
      head,
      deleted: [7],
      added: [7],
    });
    await analysePart(part, { base: CSHARP_ALLMAN, head });
    expect(part.syntax.formattingOnly.status).toBe('structure-changed');
  });

  it('refuses a comment change', async () => {
    const base = 'def f():\n    # old note\n    return 1\n';
    const head = 'def f():\n    # new note\n    return 1\n';
    const part = changedPart({ path: 'a.py', base, head, deleted: [2], added: [2] });
    await analysePart(part, { base, head });
    expect(part.syntax.formattingOnly.status).toBe('structure-changed');
  });

  it('does not check a file with syntax errors, but still names its entities', async () => {
    const base = 'def f():\n    return 1\n';
    const head = 'def f():\n    return (1\n';
    const part = changedPart({ path: 'a.py', base, head, deleted: [2], added: [2] });
    await analysePart(part, { base, head });
    expect(part.syntax.formattingOnly).toEqual({
      status: 'not-checked',
      reason: 'the head version has syntax errors, so its structure cannot be compared',
    });
    expect(part.syntax.checksNotRun).toEqual([
      { check: 'formatting-only', reason: part.syntax.formattingOnly.reason },
    ]);
    expect(part.hunks[0]!.entities).toEqual([{ kind: 'function', name: 'f' }]);
  });

  it('compares deeply nested code without exhausting the stack', async () => {
    const base = `total = ${Array.from({ length: 20000 }, () => '1').join(' + ')}\n`;
    const head = `total = ${Array.from({ length: 20000 }, () => '1').join('+')}\n`;
    const part = changedPart({ path: 'deep.py', base, head, deleted: [1], added: [1] });
    await analysePart(part, { base, head });
    expect(part.syntax.formattingOnly.status).toBe('confirmed');
  });

  it('reports an added file as more than formatting', async () => {
    const head = 'def fresh():\n    return 1\n';
    const part = changedPart({ path: 'a.py', head, added: [1, 2], changeKind: 'addition' });
    await analysePart(part, { head });
    expect(part.syntax.formattingOnly).toEqual({
      status: 'structure-changed',
      reason: 'the file is new',
    });
    expect(part.hunks[0]!.entities).toEqual([{ kind: 'function', name: 'fresh' }]);
  });
});

/** Whitespace that is content: inside strings, comments and the like. */
const CONTENT_WHITESPACE: [string, string, string][] = [
  ['a.py', 'x = f"{a} {b}"\n', 'x = f"{a}  {b}"\n'],
  ['a.py', 'x = f"{a} {b}"\n', 'x = f"{a}{b}"\n'],
  ['a.py', 'x = "a b"\n', 'x = "a  b"\n'],
  ['a.py', 'x = """a\n b"""\n', 'x = """a\n  b"""\n'],
  ['a.ts', 'const x = `${a} ${b}`;\n', 'const x = `${a}  ${b}`;\n'],
  ['a.ts', 'const x = `${a} ${b}`;\n', 'const x = `${a}${b}`;\n'],
  ['a.js', 'const x = `a ${b} c`;\n', 'const x = `a  ${b} c`;\n'],
  [
    'a.cs',
    'class C { string M() { return $"{a} {b}"; } }\n',
    'class C { string M() { return $"{a}  {b}"; } }\n',
  ],
  [
    'a.cs',
    'class C { string M() { return $"{a} {b}"; } }\n',
    'class C { string M() { return $"{a}{b}"; } }\n',
  ],
  [
    'a.cs',
    'class C { string M() { return @"a b"; } }\n',
    'class C { string M() { return @"a  b"; } }\n',
  ],
  [
    'a.cs',
    'class C { string M() { return """\n  a b\n  """; } }\n',
    'class C { string M() { return """\n  a  b\n  """; } }\n',
  ],
  ['a.go', 'package p\nvar x = `a b`\n', 'package p\nvar x = `a  b`\n'],
  ['a.go', 'package p\nvar x = "a b"\n', 'package p\nvar x = "a  b"\n'],
  ['a.rs', 'fn f() { let x = "a b"; }\n', 'fn f() { let x = "a  b"; }\n'],
  ['a.rs', 'fn f() { let x = r"a b"; }\n', 'fn f() { let x = r"a  b"; }\n'],
  ['a.rs', 'fn f() { let x = r#"a b"#; }\n', 'fn f() { let x = r#"a  b"#; }\n'],
  ['a.java', 'class C { String s = "a b"; }\n', 'class C { String s = "a  b"; }\n'],
  [
    'a.java',
    'class C { String s = """\n  a b\n  """; }\n',
    'class C { String s = """\n  a  b\n  """; }\n',
  ],
  ['a.java', "class C { char c = ' '; }\n", "class C { char c = '  '; }\n"],
  ['a.rs', "fn f() { let c = ' '; }\n", "fn f() { let c = '\t'; }\n"],
  ['a.py', 'x = 1 # a b\n', 'x = 1 # a  b\n'],
  ['a.ts', 'const x = /a b/;\n', 'const x = /a  b/;\n'],
  ['a.tsx', 'const x = <div>a b</div>;\n', 'const x = <div>a  b</div>;\n'],
  ['a.tsx', 'const x = <div>{a} {b}</div>;\n', 'const x = <div>{a}{b}</div>;\n'],
  ['a.jsx', 'const x = <div>{a} {b}</div>;\n', 'const x = <div>{a}{b}</div>;\n'],
  ['a.go', "package p\nvar x = 'a'\n", "package p\nvar x = ' '\n"],
];

describe('whitespace that is content', () => {
  it.each(CONTENT_WHITESPACE)('is not formatting in %s: %j', async (path, base, head) => {
    const part = changedPart({ path, base, head, deleted: [1], added: [1] });
    await analysePart(part, { base, head });
    expect(part.syntax.formattingOnly.status).toBe('structure-changed');
  });
});

/** Whitespace inside an interpolation wrapper hugs code, not string text. */
const INTERPOLATION_WHITESPACE: [string, string, string][] = [
  ['a.ts', 'const x = `${a}`;\n', 'const x = `${ a }`;\n'],
  ['a.tsx', 'const x = `${a}`;\n', 'const x = `${ a }`;\n'],
  ['a.js', 'const x = `${a}`;\n', 'const x = `${ a }`;\n'],
  ['a.ts', 'type T = `a${U}b`;\n', 'type T = `a${ U }b`;\n'],
];

describe('whitespace inside an interpolation', () => {
  it.each(INTERPOLATION_WHITESPACE)('is formatting in %s: %j', async (path, base, head) => {
    const part = changedPart({ path, base, head, deleted: [1], added: [1] });
    await analysePart(part, { base, head });
    expect(part.syntax.formattingOnly.status).toBe('confirmed');
  });
});

/** One changed line inside an entity, per language. */
const ENTITY_CASES: {
  path: string;
  source: string;
  line: number;
  expected: string;
  kind: string;
}[] = [
  {
    path: 'app/store.py',
    source:
      '@cached\ndef load():\n    return 1\n\nclass Store:\n    def path_for(self):\n        return 2\n',
    line: 7,
    expected: 'Store.path_for',
    kind: 'method',
  },
  {
    path: 'app/store.py',
    source: '@cached\ndef load():\n    return 1\n',
    line: 1,
    expected: 'load',
    kind: 'function',
  },
  {
    path: 'src/Orders.cs',
    source:
      'namespace Shop;\npublic class Orders\n{\n    public int Count { get { return 1; } }\n}\n',
    line: 4,
    expected: 'Orders.Count',
    kind: 'property',
  },
  {
    path: 'web/cart.ts',
    source: 'export class Cart {\n  total(): number {\n    return 1;\n  }\n}\n',
    line: 3,
    expected: 'Cart.total',
    kind: 'method',
  },
  {
    path: 'web/cart.ts',
    source: 'interface Cart {\n  total(): number;\n}\n',
    line: 2,
    expected: 'Cart.total',
    kind: 'method',
  },
  {
    path: 'types/global.d.ts',
    source: 'declare function loadConfig(): void;\n',
    line: 1,
    expected: 'loadConfig',
    kind: 'function',
  },
  {
    path: 'web/api.ts',
    source: 'export function ping(): void {\n  send();\n}\n',
    line: 1,
    expected: 'ping',
    kind: 'function',
  },
  {
    path: 'types/global.d.ts',
    source: 'export declare function loadConfig(): void;\n',
    line: 1,
    expected: 'loadConfig',
    kind: 'function',
  },
  {
    path: 'web/cart.ts',
    source: 'export const isEmpty = (): boolean => true;\n',
    line: 1,
    expected: 'isEmpty',
    kind: 'function',
  },
  {
    path: 'web/Cart.ts',
    source: 'export default class Cart {\n  total(): number;\n}\n',
    line: 1,
    expected: 'Cart',
    kind: 'class',
  },
  {
    path: 'web/cart.ts',
    source: 'export const isEmpty = (items: number[]): boolean =>\n  items.length === 0;\n',
    line: 2,
    expected: 'isEmpty',
    kind: 'function',
  },
  {
    path: 'web/view.tsx',
    source: 'export function Badge() {\n  return <span>new</span>;\n}\n',
    line: 2,
    expected: 'Badge',
    kind: 'function',
  },
  {
    path: 'web/legacy.js',
    source: 'class Legacy {\n  run() {\n    return 1;\n  }\n}\n',
    line: 3,
    expected: 'Legacy.run',
    kind: 'method',
  },
  {
    path: 'cmd/server.go',
    source: 'package main\n\nfunc (s *Server) Start() error {\n\treturn nil\n}\n',
    line: 4,
    expected: 'Server.Start',
    kind: 'method',
  },
  {
    path: 'cmd/server.go',
    source: 'package main\n\ntype Server struct {\n\tport int\n}\n',
    line: 4,
    expected: 'Server',
    kind: 'struct',
  },
  {
    path: 'src/server.rs',
    source: 'impl Server {\n    fn start(&self) {\n        run();\n    }\n}\n',
    line: 3,
    expected: 'Server.start',
    kind: 'method',
  },
  {
    path: 'src/main.rs',
    source: 'fn main() {\n    run();\n}\n',
    line: 2,
    expected: 'main',
    kind: 'function',
  },
  {
    path: 'src/Orders.java',
    source: 'class Orders {\n  void place() {\n    send();\n  }\n}\n',
    line: 3,
    expected: 'Orders.place',
    kind: 'method',
  },
];

describe('entity names', () => {
  it.each(ENTITY_CASES)(
    'names $expected in $path',
    async ({ path, source, line, expected, kind }) => {
      const part = changedPart({
        path,
        base: source,
        head: source,
        deleted: [line],
        added: [line],
      });
      await analysePart(part, { base: source, head: source });
      expect(part.syntax.checksNotRun.map((check) => check.check)).not.toContain('entities');
      expect(part.hunks[0]!.entities).toEqual([{ kind, name: expected }]);
    },
  );

  it('names nothing for top-level code outside any entity', async () => {
    const source = 'import os\nVALUE = 1\n';
    const part = changedPart({
      path: 'a.py',
      base: source,
      head: source,
      deleted: [2],
      added: [2],
    });
    await analysePart(part, { base: source, head: source });
    expect(part.hunks[0]!.entities).toEqual([]);
  });

  it('names nothing for a bare export clause', async () => {
    const source = 'function load() {}\nexport { load };\n';
    const part = changedPart({
      path: 'a.ts',
      base: source,
      head: source,
      deleted: [2],
      added: [2],
    });
    await analysePart(part, { base: source, head: source });
    expect(part.hunks[0]!.entities).toEqual([]);
  });

  it('covers Python, C#, TypeScript, JavaScript, Go, Rust and Java', () => {
    const languages = ENTITY_CASES.map((entityCase) => languageForPath(entityCase.path)?.name);
    for (const name of [
      'python',
      'c-sharp',
      'typescript',
      'tsx',
      'javascript',
      'go',
      'rust',
      'java',
    ]) {
      expect(languages).toContain(name);
    }
  });
});

describe('files the syntax pass cannot read', () => {
  it('falls back to file level for a language without a grammar, and says why', async () => {
    const source = 'def deploy\n  run\nend\n';
    const part = changedPart({
      path: 'scripts/deploy.rb',
      base: source,
      head: source,
      deleted: [2],
      added: [2],
    });
    const { parseTimeMs } = await analysePart(part, { base: source, head: source });
    const reason = 'no grammar for ".rb" files, so its hunks are read at file level';
    expect(part.syntax).toEqual({
      language: undefined,
      formattingOnly: { status: 'not-checked', reason },
      checksNotRun: [
        { check: 'entities', reason },
        { check: 'formatting-only', reason },
      ],
    });
    expect(part.hunks[0]!.entities).toEqual([]);
    expect(parseTimeMs).toBe(0);
  });

  it('names files without an extension plainly', async () => {
    const part = changedPart({
      path: 'Makefile',
      base: 'a\n',
      head: 'b\n',
      deleted: [1],
      added: [1],
    });
    await analysePart(part, { base: 'a\n', head: 'b\n' });
    expect(part.syntax.formattingOnly.reason).toBe(
      'no grammar for files without an extension, so its hunks are read at file level',
    );
  });

  it('says so when a copy lacks the file', async () => {
    const part = changedPart({
      path: 'a.py',
      base: 'x = 1\n',
      head: 'x = 2\n',
      deleted: [1],
      added: [1],
    });
    await analysePart(part, { head: 'x = 2\n' });
    expect(part.syntax.formattingOnly.reason).toBe(
      'the base copy has no such file; archives leave out export-ignore paths',
    );
    expect(part.syntax.checksNotRun.map((check) => check.check)).toEqual([
      'entities',
      'formatting-only',
    ]);
  });

  it('refuses copies that disagree with the diff', async () => {
    const part = changedPart({
      path: 'a.py',
      base: 'x = 1\n',
      head: 'x = 2\n',
      deleted: [1],
      added: [1],
    });
    await analysePart(part, { base: 'x = 1\n', head: 'x = 3\n' });
    expect(part.syntax.formattingOnly.reason).toBe(
      'the head copy does not match the diff at line 1',
    );
  });

  it('skips binary files', async () => {
    const part = changedPart({ path: 'logo.png' });
    part.isBinary = true;
    part.hunks = [];
    await analysePart(part, {});
    expect(part.syntax.formattingOnly.reason).toBe('the file is binary');
  });
});
