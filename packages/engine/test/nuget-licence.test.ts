import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decompileLicence, expressionPermits } from '../src/nuget-licence.js';
import { readZipEntries } from '../src/zip.js';

/** The nuspec of a package fixture, as its text. */
function nuspecOf(path: string): string {
  const entry = readZipEntries(readFileSync(fileURLToPath(new URL(path, import.meta.url)))).find((each) => each.name.endsWith('.nuspec'))!;
  return Buffer.from(entry.read()).toString('utf8');
}

const nuspec = (metadata: string): string => `<?xml version="1.0"?><package><metadata><id>Example</id><version>2.0.0</version>${metadata}</metadata></package>`;

describe('expressionPermits', () => {
  it('allows an open-source licence, however SPDX spells its version range', () => {
    for (const expression of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'LGPL-2.1-or-later', 'GPL-3.0-only', 'MPL-2.0', 'MS-PL', 'LGPL-2.1+', 'mit']) {
      expect(expressionPermits(expression), expression).toBe(true);
    }
  });

  it('needs one side of OR, both sides of AND, and only the licence of a WITH exception', () => {
    expect(expressionPermits('MIT OR LicenseRef-Proprietary')).toBe(true);
    expect(expressionPermits('MIT AND LicenseRef-Proprietary')).toBe(false);
    expect(expressionPermits('(MIT AND Apache-2.0) OR BUSL-1.1')).toBe(true);
    expect(expressionPermits('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(true);
    expect(expressionPermits('BUSL-1.1 WITH Classpath-exception-2.0')).toBe(false);
  });

  it('reads nothing from a malformed expression', () => {
    for (const expression of ['', 'MIT OR', '(MIT', 'MIT)', 'MIT Apache-2.0', 'AND', 'MIT WITH', 'MIT WITH (Apache-2.0)']) {
      expect(expressionPermits(expression), expression).toBeUndefined();
    }
  });
});

describe('decompileLicence', () => {
  it('allows decompiling a version licensed under a permissive expression, or the licenses.nuget.org link that stands for one', () => {
    expect(decompileLicence(nuspec('<license type="expression">MIT</license>'), '2.0.0')).toEqual({
      kind: 'permissive',
      licence: 'MIT',
      why: 'its licence at version 2.0.0, MIT, allows decompiling it',
    });
    expect(decompileLicence(nuspec('<licenseUrl>https://licenses.nuget.org/Apache-2.0%20OR%20MIT</licenseUrl>'), '2.0.0')).toMatchObject({
      kind: 'permissive',
      licence: 'Apache-2.0 OR MIT',
    });
  });

  it('refuses a version whose licence is not an open-source licence known to allow it', () => {
    expect(decompileLicence(nuspec('<license type="expression">BUSL-1.1</license>'), '2.0.0')).toEqual({
      kind: 'restrictive',
      licence: 'BUSL-1.1',
      why: 'its licence at version 2.0.0, BUSL-1.1, is not an open-source licence known to allow decompiling it',
    });
    expect(decompileLicence(nuspec('<license type="expression">MIT AND LicenseRef-Proprietary</license>'), '2.0.0')).toMatchObject({ kind: 'restrictive' });
  });

  it('counts a licence it cannot judge as unknown: a file, another link, none, or an unreadable expression', () => {
    expect(decompileLicence(nuspec('<license type="file">EULA.txt</license><licenseUrl>https://aka.ms/deprecateLicenseUrl</licenseUrl>'), '2.0.0')).toEqual({
      kind: 'unknown',
      why: 'its licence at version 2.0.0 is unknown: its nuspec gives it only as the file EULA.txt in the package, which the companion does not judge',
    });
    expect(decompileLicence(nuspec('<licenseUrl>https://example.com/license</licenseUrl>'), '2.0.0')).toEqual({
      kind: 'unknown',
      why: 'its licence at version 2.0.0 is unknown: its nuspec gives it only as a link, https://example.com/license, which the companion does not judge',
    });
    expect(decompileLicence(nuspec(''), '2.0.0')).toEqual({ kind: 'unknown', why: 'its licence at version 2.0.0 is unknown: its nuspec names none' });
    expect(decompileLicence(nuspec('<license type="expression">MIT OR</license>'), '2.0.0')).toMatchObject({ kind: 'unknown', licence: 'MIT OR' });
  });

  it('checks each version by its own nuspec, since a licence changes between versions', () => {
    const old = decompileLicence(nuspecOf('./fixtures/pdb/Microsoft.IO.RecyclableMemoryStream.1.2.2.nupkg'), '1.2.2');
    const current = decompileLicence(
      nuspecOf('../../evaluation/cases/canary-csharp/fetched/api.nuget.org/v3-flatcontainer/microsoft.io.recyclablememorystream/3.0.1/microsoft.io.recyclablememorystream.3.0.1.nupkg'),
      '3.0.1',
    );

    expect(old).toEqual({
      kind: 'unknown',
      why: 'its licence at version 1.2.2 is unknown: its nuspec gives it only as a link, https://github.com/Microsoft/Microsoft.IO.RecyclableMemoryStream/blob/master/LICENSE, which the companion does not judge',
    });
    expect(current).toEqual({ kind: 'permissive', licence: 'MIT', why: 'its licence at version 3.0.1, MIT, allows decompiling it' });
  });
});
