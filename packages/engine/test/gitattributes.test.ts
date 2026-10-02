import { describe, expect, it } from 'vitest';
import { linguistAttributesFor } from '../src/gitattributes.js';

describe('linguistAttributesFor', () => {
  it('matches a slash-free pattern against the basename anywhere', () => {
    const source = '*.g.cs linguist-generated=true';
    expect(linguistAttributesFor('src/deep/Form1.g.cs', source)).toEqual({
      generated: true,
      vendored: false,
    });
    expect(linguistAttributesFor('src/Form1.ts', source).generated).toBe(false);
  });

  it('anchors a pattern with a slash to the repository root', () => {
    const source = 'src/generated/** linguist-generated=true';
    expect(linguistAttributesFor('src/generated/options.json', source).generated).toBe(true);
    expect(linguistAttributesFor('other/generated/options.json', source).generated).toBe(false);
  });

  it('reads ** across directories, including zero of them', () => {
    const source = '**/generated/*.json linguist-generated';
    expect(linguistAttributesFor('generated/options.json', source).generated).toBe(true);
    expect(linguistAttributesFor('a/b/generated/options.json', source).generated).toBe(true);
    expect(linguistAttributesFor('a/b/generated/deep/options.json', source).generated).toBe(false);
  });

  it('keeps * and ? within one directory', () => {
    const source = 'docs/*.md linguist-vendored';
    expect(linguistAttributesFor('docs/guide.md', source).vendored).toBe(true);
    expect(linguistAttributesFor('docs/deep/guide.md', source).vendored).toBe(false);
    expect(linguistAttributesFor('src/guide.md', source).vendored).toBe(false);
  });

  it('supports character classes', () => {
    const source = 'src/[abc]odule.ts linguist-generated=true';
    expect(linguistAttributesFor('src/aodule.ts', source).generated).toBe(true);
    expect(linguistAttributesFor('src/module.ts', source).generated).toBe(false);
  });

  it('lets a later matching line take precedence, as git reads it', () => {
    const source = [
      '*.lock linguist-vendored=true',
      'Cargo.lock -linguist-vendored',
      'special/*.lock linguist-vendored=true',
    ].join('\n');
    expect(linguistAttributesFor('yarn.lock', source).vendored).toBe(true);
    expect(linguistAttributesFor('Cargo.lock', source).vendored).toBe(false);
    expect(linguistAttributesFor('special/gold.lock', source).vendored).toBe(true);
  });

  it('treats =false as a clear, not an unset', () => {
    const source = ['*.min.js linguist-generated=true', 'keep.min.js linguist-generated=false'].join(
      '\n',
    );
    expect(linguistAttributesFor('bundle.min.js', source).generated).toBe(true);
    expect(linguistAttributesFor('keep.min.js', source).generated).toBe(false);
  });

  it('ignores comments, blanks, and other attributes', () => {
    const source = [
      '# a comment',
      '',
      'docs/* linguist-documentation',
      '*.rst linguist-documentation=true',
      'changelog.rst linguist-language=Markdown',
    ].join('\n');
    expect(linguistAttributesFor('docs/guide.rst', source)).toEqual({
      generated: false,
      vendored: false,
    });
  });

  it('reads a C-quoted pattern', () => {
    const source = '"t\\303\\251l\\303\\251charg\\303\\251s/**" linguist-vendored=true';
    expect(linguistAttributesFor('téléchargés/lib.js', source).vendored).toBe(true);
    expect(linguistAttributesFor('src/lib.js', source).vendored).toBe(false);
  });

  it('matches a bare directory pattern against files inside it', () => {
    const source = 'third-party/ linguist-vendored';
    expect(linguistAttributesFor('third-party/lib.js', source).vendored).toBe(true);
    expect(linguistAttributesFor('third-party/deep/lib.js', source).vendored).toBe(true);
    expect(linguistAttributesFor('other/lib.js', source).vendored).toBe(false);
  });

  it('matches a directory pattern at any depth and expands its wildcards', () => {
    const source = ['vendor/ linguist-vendored', 'src/**/gen/ linguist-vendored'].join('\n');
    expect(linguistAttributesFor('vendor/lib.js', source).vendored).toBe(true);
    expect(linguistAttributesFor('packages/a/vendor/lib.js', source).vendored).toBe(true);
    expect(linguistAttributesFor('src/gen/x.js', source).vendored).toBe(true);
    expect(linguistAttributesFor('src/a/gen/x.js', source).vendored).toBe(true);
    expect(linguistAttributesFor('src/a/other/x.js', source).vendored).toBe(false);
  });

  it('treats a leading slash as an anchor, not a literal to match', () => {
    const source = '/vendor/** linguist-vendored';
    expect(linguistAttributesFor('vendor/lib.js', source).vendored).toBe(true);
    expect(linguistAttributesFor('a/vendor/lib.js', source).vendored).toBe(false);
  });

  it('negates a character class written with [!...], as wildmatch does', () => {
    const source = 'src/[!t]est.ts linguist-generated=true';
    expect(linguistAttributesFor('src/best.ts', source).generated).toBe(true);
    expect(linguistAttributesFor('src/test.ts', source).generated).toBe(false);
  });

  it('splits the pattern from its attributes on any whitespace', () => {
    const source = '*.g.cs\tlinguist-generated=true';
    expect(linguistAttributesFor('src/Form1.g.cs', source).generated).toBe(true);
  });
});
