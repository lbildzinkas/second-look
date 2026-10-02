import { describe, expect, it } from 'vitest';
import { parseToml } from '../src/toml.js';

describe('parseToml', () => {
  it('reads tables, dotted paths and every plain value', () => {
    const doc = parseToml(`
# a comment
title = "lock"

[owner]
name = "example"
dedicated = true
members = 3
spacing = 1_000
weight = 0.25
gap = 1e3
hex = 0xff

[owner."display name"]
plain = 'C:\\raw\\path'
`);
    expect(doc).toEqual({
      title: 'lock',
      owner: {
        name: 'example',
        dedicated: true,
        members: 3,
        spacing: 1000,
        weight: 0.25,
        gap: 1000,
        hex: 255,
        'display name': { plain: 'C:\\raw\\path' },
      },
    });
  });

  it('reads arrays over many lines, with trailing commas and comments', () => {
    const doc = parseToml(`
dependencies = [
    "httpx>=0.24",  # the client
    "rich>=13.0",
]
matrix = [[1, 2], [3]]
empty = []
`);
    expect(doc).toEqual({
      dependencies: ['httpx>=0.24', 'rich>=13.0'],
      matrix: [
        [1, 2],
        [3],
      ],
      empty: [],
    });
  });

  it('reads arrays of tables, and tables that reopen inside them', () => {
    const doc = parseToml(`
[[package]]
name = "httpx"
version = "0.27.0"

[package.dependencies]
certifi = "*"

[[package]]
name = "certifi"
version = "2024.2.2"

[metadata]
lock-version = "2.0"
`);
    expect(doc).toEqual({
      package: [
        { name: 'httpx', version: '0.27.0', dependencies: { certifi: '*' } },
        { name: 'certifi', version: '2024.2.2' },
      ],
      metadata: { 'lock-version': '2.0' },
    });
  });

  it('reads inline tables, including nested and dotted ones', () => {
    const doc = parseToml(`
source = { registry = "https://pypi.org/simple" }
nested = { name = "idna", marker = { python = ">=3.8" } }
dotted.key = "value"
serde = { version = "1.0", features = ["derive"] }
`);
    expect(doc).toEqual({
      source: { registry: 'https://pypi.org/simple' },
      nested: { name: 'idna', marker: { python: '>=3.8' } },
      dotted: { key: 'value' },
      serde: { version: '1.0', features: ['derive'] },
    });
  });

  it('unescapes basic strings and reads multi-line strings', () => {
    const doc = parseToml(`
tab = "a\\tb"
line = "a\\nb"
quote = "say \\"hi\\""
hex = "\\u0041"
poem = """
Roses are red,\\
  violets are blue.
"""
literal = '''
C:\\nowhere\\at all
'''
`);
    expect(doc).toEqual({
      tab: 'a\tb',
      line: 'a\nb',
      quote: 'say "hi"',
      hex: 'A',
      poem: 'Roses are red,violets are blue.\n',
      literal: 'C:\\nowhere\\at all\n',
    });
  });

  it('reads quoted keys in headers, as Cargo manifests write them', () => {
    const doc = parseToml(`
[target.'cfg(windows)'.dependencies]
winapi = "0.3"
`);
    expect(doc).toEqual({ target: { 'cfg(windows)': { dependencies: { winapi: '0.3' } } } });
  });

  it('refuses whatever is outside the subset, returning undefined', () => {
    for (const broken of [
      'value = 1979-05-27T07:32:00Z', // dates
      'value', // no equals
      'value = ', // no value
      'value = "unterminated',
      'value = truex', // a bad bare word
      '[table', // unterminated header
      'a.b = 1\na.b = 2', // redefinition
      'x = [1, 2', // unterminated array
      'x = { a = 1', // unterminated inline table
      '= 1', // no key
      'value = "\\U00110000"', // above the Unicode range
    ]) {
      expect(parseToml(broken), broken).toBeUndefined();
    }
  });

  it('reads an empty document as an empty table', () => {
    expect(parseToml('')).toEqual({});
    expect(parseToml('\n# only a comment\n')).toEqual({});
  });

  it('reads unicode escapes up to the top of the range', () => {
    expect(parseToml('value = "\\U0010FFFF"')).toEqual({ value: '\u{10FFFF}' });
    expect(parseToml('value = "\\u00e9"')).toEqual({ value: 'é' });
  });
});
