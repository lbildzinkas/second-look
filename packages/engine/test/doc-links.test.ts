import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DOTNET_XREF_MAP, findDocLinks, pythonDocsUrls, pythonImports, sphinxInventoryUrls } from '../src/doc-links.js';
import {
  DOC_LINKS_INSTRUCTIONS,
  DOC_LINKS_PROMPT_VERSION,
  docSuggestionProblems,
  suggestedLinks,
  suggestDocLinks,
} from '../src/doc-suggestions.js';
import type { LibraryApi, Part } from '../src/protocol.js';
import { changedPart, recordedFetch, scriptedAgent } from './helpers.js';

function recorded(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/docs/${name}`, import.meta.url)));
}

/** A head copy holding the given files, by path. */
function headCopy(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'second-look-docs-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A Sphinx inventory of the given version, as a documentation site serves it, listing each api as a class of its own. */
function sphinxInventory(version: string, apis: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from(`# Sphinx inventory version 2\n# Project: many\n# Version: ${version}\n# The remainder of this file is compressed using zlib.\n`),
    deflateSync(Buffer.from(apis.map((api) => `${api} py:class 1 api.html#$ ${api}`).join('\n'))),
  ]);
}

/** A part adding every line of a new file. */
function added(path: string, text: string): Part {
  const lines = text.split('\n').length;
  return changedPart({ path, head: text, added: Array.from({ length: lines }, (_, index) => index + 1), changeKind: 'addition' });
}

const MODEL = [
  'import attrs',
  'from attrs import define as frozen_define',
  'import requests',
  'from app import helpers',
  '',
  '',
  '@frozen_define',
  'class Point:',
  '    x: int = attrs.field(default=0)  # attrs.Factory is not used',
  '    label: str = "attrs.validators is only text"',
  '',
  'def fetch() -> None:',
  '    requests.get(helpers.URL)',
].join('\n');

const ATTRS_23_1 = {
  'https://pypi.org/pypi/attrs/23.1.0/json': recorded('pypi-attrs-23.1.0.json'),
  'https://www.attrs.org/en/23.1.0/objects.inv': recorded('attrs-23.1.0-objects.inv'),
};

describe('findDocLinks for Python', () => {
  it("links the pinned library's APIs the added lines use from its Sphinx inventory at the pinned version", async () => {
    const headRoot = headCopy({ 'requirements.txt': 'attrs==23.1.0\n', 'app/model.py': MODEL });
    const transport = recordedFetch(ATTRS_23_1);
    const links = await findDocLinks([added('app/model.py', MODEL)], { headRoot, fetch: transport.fetch });
    const pinned = { library: 'attrs', version: '23.1.0', pinnedBy: 'requirements.txt', ecosystem: 'PyPI', from: 'inventory', inventory: 'https://www.attrs.org/en/23.1.0/objects.inv' };
    expect(links.links).toEqual([
      { api: 'attrs.define', ...pinned, uses: [{ path: 'app/model.py', line: 7, name: 'frozen_define' }], url: 'https://www.attrs.org/en/23.1.0/api.html#attrs.define' },
      { api: 'attrs.field', ...pinned, uses: [{ path: 'app/model.py', line: 9, name: 'field' }], url: 'https://www.attrs.org/en/23.1.0/api.html#attrs.field' },
    ]);
    expect(links.unlinked).toEqual([]);
    expect(links.notes).toEqual(['attrs 23.1.0: read the Sphinx inventory at https://www.attrs.org/en/23.1.0/objects.inv, which documents 23.1']);
    expect(links.suggestions).toBeUndefined();
    // requests is not pinned, and app is the project's own: neither is looked for.
    expect(transport.requests.map((request) => request.url)).toEqual(Object.keys(ATTRS_23_1));
  });

  it('gives no link from an inventory of another version, and says which versions were found', async () => {
    const headRoot = headCopy({ 'requirements.txt': 'attrs==22.2.0\n', 'app/model.py': MODEL });
    const transport = recordedFetch({
      'https://pypi.org/pypi/attrs/22.2.0/json': recorded('pypi-attrs-23.1.0.json'),
      'https://www.attrs.org/en/22.2.0/objects.inv': 404,
      'https://www.attrs.org/en/v22.2.0/objects.inv': 404,
      'https://www.attrs.org/en/22.2.x/objects.inv': 404,
      'https://www.attrs.org/en/stable/objects.inv': recorded('attrs-stable-objects.inv'),
      'https://www.attrs.org/en/latest/objects.inv': 404,
      'https://www.attrs.org/objects.inv': 404,
    });
    const links = await findDocLinks([added('app/model.py', MODEL)], { headRoot, fetch: transport.fetch });
    expect(links.links).toEqual([]);
    expect(links.unlinked.map((api) => [api.api, api.version])).toEqual([
      ['attrs.define', '22.2.0'],
      ['attrs.field', '22.2.0'],
    ]);
    expect(links.notes).toEqual([
      'attrs 22.2.0: no Sphinx inventory under https://www.attrs.org/ documents 22.2.0; https://www.attrs.org/en/stable/objects.inv documents 26.1',
    ]);
  });

  it('says plainly when PyPI cannot be read, and gives no link', async () => {
    const headRoot = headCopy({ 'requirements.txt': 'attrs==23.1.0\n', 'app/model.py': MODEL });
    const links = await findDocLinks([added('app/model.py', MODEL)], { headRoot, fetch: recordedFetch({ 'https://pypi.org/pypi/attrs/23.1.0/json': 404 }).fetch });
    expect(links.links).toEqual([]);
    expect(links.notes).toEqual(['attrs 23.1.0: PyPI has no release attrs 23.1.0']);
  });

  it('names how many APIs are left out when a change uses more than the cap lists', async () => {
    const linked = Array.from({ length: 62 }, (_, index) => `many.Api${index}`);
    const model = ['import many', '', 'def use() -> None:']
      .concat(linked.map((api) => `    ${api}()`), Array.from({ length: 5 }, (_, index) => `    many.Unmapped${index}()`))
      .join('\n');
    const headRoot = headCopy({ 'requirements.txt': 'many==1.0.0\n', 'app/many.py': model });
    const transport = recordedFetch({
      'https://pypi.org/pypi/many/1.0.0/json': Buffer.from(JSON.stringify({ info: { project_urls: { Documentation: 'https://many.example.org/' } } })),
      'https://many.example.org/en/1.0.0/objects.inv': sphinxInventory('1.0', linked),
    });
    const links = await findDocLinks([added('app/many.py', model)], { headRoot, fetch: transport.fetch });
    expect(links.links.map((link) => link.api)).toEqual(linked.slice(0, 60));
    expect(links.links[0]).toMatchObject({ url: 'https://many.example.org/en/1.0.0/api.html#many.Api0', library: 'many', version: '1.0.0', from: 'inventory' });
    expect(links.unlinked).toEqual([]);
    expect(links.notes).toEqual([
      'many 1.0.0: read the Sphinx inventory at https://many.example.org/en/1.0.0/objects.inv, which documents 1.0',
      'At most 60 library APIs are listed, so 2 with a link and 5 without one are left out',
    ]);
  });

  it('reads the names a file imports, aliases and parenthesised lists included', () => {
    const imports = pythonImports(['import os.path', 'import numpy as np, attrs', 'from attrs import (', '    define,', '    field as f,', ')', 'from . import local'].join('\n'));
    expect(Object.fromEntries(imports)).toEqual({ os: 'os', np: 'numpy', attrs: 'attrs', define: 'attrs.define', f: 'attrs.field' });
  });

  it("takes a documentation root only from PyPI's https documentation links, or a Read the Docs home page", () => {
    expect(pythonDocsUrls({ project_urls: { Documentation: 'https://www.attrs.org/', Source: 'https://github.com/python-attrs/attrs' } })).toEqual(['https://www.attrs.org/']);
    expect(pythonDocsUrls({ project_urls: { Docs: 'http://insecure.example.org/' }, home_page: 'https://example.readthedocs.io/en/latest/' })).toEqual(['https://example.readthedocs.io/en/latest/']);
    expect(pythonDocsUrls({ project_urls: { Documentation: 'https://127.0.0.1/' }, home_page: 'https://example.org/' })).toEqual([]);
  });

  it("looks for a version's inventory in Read the Docs' folders first, under the documentation root", () => {
    expect(sphinxInventoryUrls('https://urllib3.readthedocs.io/en/stable/index.html', '2.0.7')).toEqual([
      'https://urllib3.readthedocs.io/en/2.0.7/objects.inv',
      'https://urllib3.readthedocs.io/en/v2.0.7/objects.inv',
      'https://urllib3.readthedocs.io/en/2.0.x/objects.inv',
      'https://urllib3.readthedocs.io/en/stable/objects.inv',
      'https://urllib3.readthedocs.io/en/latest/objects.inv',
      'https://urllib3.readthedocs.io/objects.inv',
    ]);
  });
});

const READER = [
  'using System.IO;',
  'using Microsoft.Extensions.Logging;',
  'using Microsoft.IO;',
  '',
  'namespace BlobTool;',
  '',
  'public static class Reader',
  '{',
  '    // Stream.Flush is not called here.',
  '    public static string Read(Stream input, ILogger logger)',
  '    {',
  '        using var stream = new RecyclableMemoryStreamManager().GetStream();',
  '        input.CopyTo(stream);',
  '        return Path.Combine("String", Reader.Name);',
  '    }',
  '}',
].join('\n');

const PROJECT = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>',
  '  <ItemGroup>',
  '    <PackageReference Include="Microsoft.IO.RecyclableMemoryStream" Version="3.0.1" />',
  '    <PackageReference Include="Microsoft.Extensions.Logging" Version="8.0.1" />',
  '  </ItemGroup>',
  '</Project>',
].join('\n');

describe('findDocLinks for C#', () => {
  it(".NET's own APIs at the target framework from the cross-reference map, and a pinned package's types no inventory holds", async () => {
    const headRoot = headCopy({ 'src/Reader.cs': READER, 'src/BlobTool.csproj': PROJECT });
    const transport = recordedFetch({ [DOTNET_XREF_MAP]: recorded('dotnet-xrefmap-excerpt.json.gz') });
    const links = await findDocLinks([added('src/Reader.cs', READER)], { headRoot, fetch: transport.fetch });
    const framework = { library: '.NET', version: 'net8.0', pinnedBy: 'src/BlobTool.csproj', ecosystem: '.NET', from: 'inventory', inventory: DOTNET_XREF_MAP };
    expect(links.links).toEqual([
      { api: 'System.IO.Stream', ...framework, uses: [{ path: 'src/Reader.cs', line: 10, name: 'Stream' }], url: 'https://learn.microsoft.com/dotnet/api/system.io.stream?view=net-8.0' },
      { api: 'System.IO.Path.Combine', ...framework, uses: [{ path: 'src/Reader.cs', line: 14, name: 'Combine' }], url: 'https://learn.microsoft.com/dotnet/api/system.io.path.combine?view=net-8.0' },
      { api: 'System.IO.Stream.CopyTo', ...framework, uses: [{ path: 'src/Reader.cs', line: 13, name: 'CopyTo' }], url: 'https://learn.microsoft.com/dotnet/api/system.io.stream.copyto?view=net-8.0' },
    ]);
    // Two usings name a pinned package, so which one RecyclableMemoryStreamManager comes from cannot be told.
    expect(links.unlinked).toEqual([]);
    // The map documents ILogger only for later versions of the package pinned at 8.0.1.
    expect(links.notes).toEqual([
      `.NET: read the API reference's cross-reference map, ${DOTNET_XREF_MAP}`,
      '.NET: the API reference documents Microsoft.Extensions.Logging.ILogger, but not at the version pinned, so no link is given',
    ]);
  });

  it("takes a type the map does not hold as the API of the one pinned package a using names", async () => {
    const reader = READER.replace('using Microsoft.Extensions.Logging;\n', '').replace(', ILogger logger', '');
    const headRoot = headCopy({ 'src/Reader.cs': reader, 'src/BlobTool.csproj': PROJECT });
    const links = await findDocLinks([added('src/Reader.cs', reader)], { headRoot, fetch: recordedFetch({ [DOTNET_XREF_MAP]: recorded('dotnet-xrefmap-excerpt.json.gz') }).fetch });
    expect(links.links.map((link) => link.api)).toEqual(['System.IO.Stream', 'System.IO.Path.Combine', 'System.IO.Stream.CopyTo']);
    expect(links.unlinked).toEqual([
      {
        api: 'Microsoft.IO.RecyclableMemoryStreamManager',
        library: 'Microsoft.IO.RecyclableMemoryStream',
        version: '3.0.1',
        pinnedBy: 'src/BlobTool.csproj',
        ecosystem: 'NuGet',
        uses: [{ path: 'src/Reader.cs', line: 11, name: 'RecyclableMemoryStreamManager' }],
      },
    ]);
  });

  it('takes the one package a using names however often a multi-target lock file and its project file pin it', async () => {
    const reader = READER.replace('using Microsoft.Extensions.Logging;\n', '').replace(', ILogger logger', '');
    const lockHash = 'rW2McdPfbGlIqItnDDx0drRXbFXFzR9kZ0rGIlXcT7IQy1XnebOa/cGwFahCbvLZy0kRwPjMRzvnvZzXTvJbPg==';
    const lockFile = JSON.stringify({
      version: 1,
      dependencies: {
        'net8.0': { 'Microsoft.IO.RecyclableMemoryStream': { type: 'Direct', requested: '[3.0.1, )', resolved: '3.0.1', contentHash: lockHash } },
        'net9.0': { 'Microsoft.IO.RecyclableMemoryStream': { type: 'Direct', requested: '[3.0.1, )', resolved: '3.0.1', contentHash: lockHash } },
      },
    });
    const project = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup><TargetFrameworks>net8.0;net9.0</TargetFrameworks></PropertyGroup>',
      '  <ItemGroup>',
      '    <PackageReference Include="microsoft.io.recyclablememorystream" Version="3.0.1" />',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n');
    const headRoot = headCopy({ 'src/Reader.cs': reader, 'src/BlobTool.csproj': project, 'src/packages.lock.json': lockFile });
    const links = await findDocLinks([added('src/Reader.cs', reader)], { headRoot, fetch: recordedFetch({ [DOTNET_XREF_MAP]: recorded('dotnet-xrefmap-excerpt.json.gz') }).fetch });
    expect(links.links.map((link) => link.api)).toEqual(['System.IO.Stream', 'System.IO.Path.Combine', 'System.IO.Stream.CopyTo']);
    expect(links.unlinked).toEqual([
      {
        api: 'Microsoft.IO.RecyclableMemoryStreamManager',
        library: 'Microsoft.IO.RecyclableMemoryStream',
        version: '3.0.1',
        pinnedBy: 'src/packages.lock.json',
        ecosystem: 'NuGet',
        uses: [{ path: 'src/Reader.cs', line: 11, name: 'RecyclableMemoryStreamManager' }],
      },
    ]);
    expect(links.notes).toEqual([`.NET: read the API reference's cross-reference map, ${DOTNET_XREF_MAP}`]);
  });

  it('looks for nothing when no project names a target framework and nothing is pinned', async () => {
    const headRoot = headCopy({ 'src/Reader.cs': READER });
    const transport = recordedFetch({});
    const links = await findDocLinks([added('src/Reader.cs', READER)], { headRoot, fetch: transport.fetch });
    expect(links).toEqual({ links: [], unlinked: [], notes: ['.NET: no project file names a target framework and nothing pins a package, so no .NET API is linked'] });
    expect(transport.requests).toEqual([]);
  });

  it('says plainly when the map cannot be read, and links no .NET API', async () => {
    const headRoot = headCopy({ 'src/Reader.cs': READER, 'src/BlobTool.csproj': PROJECT });
    const links = await findDocLinks([added('src/Reader.cs', READER)], { headRoot, fetch: recordedFetch({ [DOTNET_XREF_MAP]: 404 }).fetch });
    expect(links.links).toEqual([]);
    expect(links.unlinked).toEqual([]);
    expect(links.notes).toEqual([`.NET: the API reference's cross-reference map could not be read, so no .NET API is linked: ${DOTNET_XREF_MAP} is not there`]);
  });

  it('notes the languages no link is looked for in', async () => {
    const links = await findDocLinks([added('web/cart.ts', 'export const total = 1;')], { headRoot: headCopy({}), fetch: recordedFetch({}).fetch });
    expect(links).toEqual({ links: [], unlinked: [], notes: ["Library APIs are linked to their documentation in Python and C# only; the change's .ts files are not read for them"] });
  });
});

const HTTPX = ['import httpx', '', 'def page(client: httpx.Client) -> str:', '    return client.get("/").text'].join('\n');

const HTTPX_API: LibraryApi = {
  api: 'httpx.Client',
  library: 'httpx',
  version: '0.27.2',
  pinnedBy: 'requirements.txt',
  ecosystem: 'PyPI',
  uses: [{ path: 'app/page.py', line: 3, name: 'Client' }],
};

describe('suggested documentation links', () => {
  it("asks the agent only for the APIs no inventory linked, and shows its links after every inventory link, labelled as the agent's", async () => {
    const page = HTTPX.replace('import httpx', 'import attrs\nimport httpx').replace('-> str:', '-> str:\n    attrs.field()');
    const headRoot = headCopy({ 'requirements.txt': 'attrs==23.1.0\nhttpx==0.27.2\n', 'app/page.py': page });
    const transport = recordedFetch({ ...ATTRS_23_1, 'https://pypi.org/pypi/httpx/0.27.2/json': 404 });
    const agent = scriptedAgent([JSON.stringify({ links: [{ api: 'a1', url: 'https://www.python-httpx.org/api/#client' }] })]);
    let suggesting = 0;
    const links = await findDocLinks([added('app/page.py', page)], {
      headRoot,
      fetch: transport.fetch,
      agent: { adapter: agent },
      onSuggesting: () => suggesting++,
    });
    expect(links.links.map((link) => [link.api, link.from, link.url])).toEqual([
      ['attrs.field', 'inventory', 'https://www.attrs.org/en/23.1.0/api.html#attrs.field'],
      ['httpx.Client', 'agent', 'https://www.python-httpx.org/api/#client'],
    ]);
    expect(links.links[1]).not.toHaveProperty('inventory');
    expect(links.unlinked).toEqual([]);
    expect(links.suggestions).toMatchObject({ promptVersion: DOC_LINKS_PROMPT_VERSION, outcome: 'suggested', stamp: { agent: 'fake', model: 'fake/model' } });
    expect(links.suggestions!.detail).toMatch(/suggested 1 of 1 links .* none was opened or checked/);
    expect(suggesting).toBe(1);
    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0]!.root).toBe(headRoot);
    expect(agent.requests[0]!.instructions).toBe(DOC_LINKS_INSTRUCTIONS);
    expect(agent.requests[0]!.prompt).toMatch(/<untrusted-input id="[0-9a-f]+" source="library APIs">\na1: httpx\.Client — httpx 0\.27\.2 from PyPI, pinned by requirements\.txt; used at app\/page\.py:4\n/);
    // A suggestion is never fetched.
    expect(transport.requests.map((request) => request.url)).not.toContain('https://www.python-httpx.org/api/#client');
  });

  it('retries an answer the checks refuse, then reports it, keeping the APIs unlinked', async () => {
    const headRoot = headCopy({ 'requirements.txt': 'httpx==0.27.2\n', 'app/page.py': HTTPX });
    const refused = JSON.stringify({ links: [{ api: 'a1', url: 'http://localhost:8000/api' }] });
    const agent = scriptedAgent([refused, refused]);
    const links = await findDocLinks([added('app/page.py', HTTPX)], {
      headRoot,
      fetch: recordedFetch({ 'https://pypi.org/pypi/httpx/0.27.2/json': 404 }).fetch,
      agent: { adapter: agent },
    });
    expect(agent.requests).toHaveLength(2);
    expect(links.links).toEqual([]);
    expect(links.unlinked.map((api) => api.api)).toEqual(['httpx.Client']);
    expect(links.suggestions).toMatchObject({ outcome: 'fell back' });
    expect(links.suggestions!.detail).toMatch(/the link for a1 is refused: it is not https/);
  });

  it('asks no agent when every API is linked', async () => {
    const headRoot = headCopy({ 'requirements.txt': 'attrs==23.1.0\n', 'app/model.py': MODEL });
    const agent = scriptedAgent([]);
    const links = await findDocLinks([added('app/model.py', MODEL)], { headRoot, fetch: recordedFetch(ATTRS_23_1).fetch, agent: { adapter: agent } });
    expect(agent.requests).toEqual([]);
    expect(links.suggestions).toBeUndefined();
  });

  it('refuses a suggestion for an API not asked about, a second one for the same API, and an address the engine would not read from', () => {
    expect(
      docSuggestionProblems(
        {
          links: [
            { api: 'a1', url: 'https://www.python-httpx.org/api/' },
            { api: 'a1', url: 'https://www.python-httpx.org/' },
            { api: 'a2', url: 'https://example.org/' },
            { api: 'httpx.Client', url: 'https://example.org/' },
          ],
        },
        [HTTPX_API],
      ),
    ).toEqual(['a1 is given more than one link', '"a2" is not the id of an API listed', '"httpx.Client" is not the id of an API listed']);
    expect(docSuggestionProblems({ links: [{ api: 'a1', url: `https://example.org/${'x'.repeat(400)}` }] }, [HTTPX_API])[0]).toMatch(/at most 400 are allowed/);
    expect(docSuggestionProblems({ links: [{ api: 'a1', url: 'https://user:pw@example.org/' }] }, [HTTPX_API])).toEqual(['the link for a1 is refused: it carries credentials']);
  });

  it('keeps only the suggestions the checks accept when the plain checks are off, as the evaluation scores the answer', async () => {
    const answer = { links: [{ api: 'a1', url: 'javascript:alert(1)' }] };
    expect(suggestedLinks(answer, [HTTPX_API])).toEqual([]);
    const result = await suggestDocLinks([HTTPX_API], { adapter: scriptedAgent([JSON.stringify(answer)]), root: headCopy({}), plainChecks: false });
    expect(result.answer).toEqual(answer);
    expect(result.links).toEqual([]);
    expect(result.suggestions.outcome).toBe('suggested');
  });
});
