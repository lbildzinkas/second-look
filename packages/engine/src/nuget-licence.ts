/**
 * Whether a NuGet package's own licence, at one version, allows the
 * companion to decompile it. Licences change between versions, so the
 * licence is read from the nuspec of the exact package the fetch
 * downloaded and checked: its `<license>` element, when that is a
 * licence expression, or — only when the nuspec has no `<license>`
 * element — nuget.org's `licenses.nuget.org` link that stands for one.
 * An expression allows it only when every licence it requires is an
 * open-source licence known to let anyone read the code; a licence
 * given as a file or another link, a missing one, or an expression the
 * companion cannot read is unknown, and unknown counts as not allowed.
 */

/** What a package version's licence says of decompiling it: allowed, refused, or unknown, which also refuses. */
export interface DecompileLicence {
  kind: 'permissive' | 'restrictive' | 'unknown';
  /** The licence as the nuspec gives it, when it gives one the companion can name. */
  licence?: string;
  /** One plain clause saying why decompiling is allowed or not. */
  why: string;
}

/**
 * The open-source licences known to let anyone read and study the code,
 * lowercase, with `-only`, `-or-later` and `+` dropped.
 */
const PERMITS_DECOMPILING = new Set([
  '0bsd', 'afl-3.0', 'agpl-3.0', 'apache-1.1', 'apache-2.0', 'artistic-2.0', 'bsd-2-clause', 'bsd-3-clause', 'bsl-1.0', 'cc0-1.0',
  'epl-1.0', 'epl-2.0', 'eupl-1.2', 'gpl-2.0', 'gpl-3.0', 'isc', 'lgpl-2.0', 'lgpl-2.1', 'lgpl-3.0', 'mit', 'mit-0', 'mpl-1.1',
  'mpl-2.0', 'ms-pl', 'ms-rl', 'ncsa', 'postgresql', 'unlicense', 'upl-1.0', 'x11', 'zlib',
]);

const OPERATOR = /^(?:AND|OR|WITH)$/i;

/** One licence identifier as {@link PERMITS_DECOMPILING} holds it. */
function permits(id: string): boolean {
  return PERMITS_DECOMPILING.has(id.toLowerCase().replace(/\+$/, '').replace(/-(?:only|or-later)$/, ''));
}

/**
 * Whether an SPDX licence expression allows decompiling: `OR` needs one
 * side to, `AND` both, and `WITH` an exception, which only adds
 * permissions, its licence; undefined when the expression is malformed.
 */
export function expressionPermits(expression: string): boolean | undefined {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let at = 0;
  const isId = (token: string | undefined): token is string => token !== undefined && token !== '(' && token !== ')' && !OPERATOR.test(token);
  const atom = (): boolean | undefined => {
    const token = tokens[at++];
    if (token === '(') {
      const value = either();
      return tokens[at++] === ')' ? value : undefined;
    }
    if (!isId(token)) return undefined;
    if (/^WITH$/i.test(tokens[at] ?? '')) {
      const exception = tokens[at + 1];
      at += 2;
      if (!isId(exception)) return undefined;
    }
    return permits(token);
  };
  const joined = (operator: RegExp, next: () => boolean | undefined, combine: (a: boolean, b: boolean) => boolean) => (): boolean | undefined => {
    let value = next();
    while (operator.test(tokens[at] ?? '')) {
      at++;
      const right = next();
      value = value === undefined || right === undefined ? undefined : combine(value, right);
    }
    return value;
  };
  const both = joined(/^AND$/i, atom, (a, b) => a && b);
  const either = joined(/^OR$/i, both, (a, b) => a || b);
  const value = either();
  return at === tokens.length ? value : undefined;
}

/** The licence expression a `licenses.nuget.org` link stands for, which nuget.org writes for a package licensed by expression. */
function linkedExpression(url: string): string | undefined {
  const match = /^https?:\/\/licenses\.nuget\.org\/(.+)$/i.exec(url);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

/** The text of one element of a nuspec, trimmed, and its attributes. */
function element(nuspec: string, name: string): { text: string; attributes: string } | undefined {
  const match = new RegExp(`<${name}\\b([^>]*)>([^<]*)</${name}\\s*>`, 'i').exec(nuspec);
  return match ? { attributes: match[1]!, text: match[2]!.trim() } : undefined;
}

/**
 * Whether the package version a nuspec describes may be decompiled, by
 * its own licence: permissive, restrictive, or unknown, with why.
 */
export function decompileLicence(nuspec: string, version: string): DecompileLicence {
  const at = `its licence at version ${version}`;
  const license = element(nuspec, 'license');
  const licenseUrl = element(nuspec, 'licenseUrl')?.text;
  const type = license === undefined ? undefined : /\btype\s*=\s*["']([^"']*)["']/i.exec(license.attributes)?.[1]?.toLowerCase();
  const expression = type === 'expression' ? license!.text : license === undefined && licenseUrl !== undefined ? linkedExpression(licenseUrl) : undefined;
  if (expression !== undefined) {
    const permitted = expressionPermits(expression);
    if (permitted === true) return { kind: 'permissive', licence: expression, why: `${at}, ${expression}, allows decompiling it` };
    if (permitted === false) return { kind: 'restrictive', licence: expression, why: `${at}, ${expression}, is not an open-source licence known to allow decompiling it` };
    return { kind: 'unknown', licence: expression, why: `${at} is unknown: its licence expression, ${expression}, is not one the companion can read` };
  }
  if (license !== undefined) return { kind: 'unknown', why: `${at} is unknown: its nuspec gives it only as the file ${license.text} in the package, which the companion does not judge` };
  if (licenseUrl !== undefined && licenseUrl !== '') return { kind: 'unknown', why: `${at} is unknown: its nuspec gives it only as a link, ${licenseUrl}, which the companion does not judge` };
  return { kind: 'unknown', why: `${at} is unknown: its nuspec names none` };
}
