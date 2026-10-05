import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { readZipEntries } from './zip.js';

/** What extracting one archive wrote and what it left out. */
export interface ExtractedArchive {
  /** Number of regular files written. */
  files: number;
  /** Entries left out, each with its reason, such as a symbolic link. */
  skipped: string[];
}

const BLOCK = 512;

/** Read-only modes for the copy: files can be read, nothing can be written or run. */
const READ_ONLY_FILE = 0o444;
const READ_ONLY_DIR = 0o555;

interface ByteReader {
  /**
   * Hands out exactly `size` bytes. Undefined at a clean end of the
   * stream; a stream that ends in the middle of a read is a truncated
   * archive and throws.
   */
  read(size: number): Promise<Buffer | undefined>;
  /** Stops reading and releases the stream. */
  close(): Promise<void>;
}

function byteReader(source: AsyncIterable<Buffer>): ByteReader {
  const iterator = source[Symbol.asyncIterator]();
  // Chunks are joined once per read, so a large entry is copied once.
  let chunks: Buffer[] = [];
  let length = 0;
  const read = async (size: number): Promise<Buffer | undefined> => {
    while (length < size) {
      const next = await iterator.next();
      if (next.done) {
        if (length === 0) return undefined;
        throw new Error('the archive ends in the middle of an entry');
      }
      chunks.push(next.value);
      length += next.value.length;
    }
    const buffered = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, length);
    const rest = buffered.subarray(size);
    chunks = rest.length === 0 ? [] : [rest];
    length = rest.length;
    return buffered.subarray(0, size);
  };
  const close = async (): Promise<void> => {
    await iterator.return?.();
  };
  return { read, close };
}

/** Tar entry types that describe the next entry instead of being one. */
const METADATA_TYPES = new Set(['x', 'g', 'L', 'K']);

/** Reads a NUL-terminated string field of a tar header. */
function textField(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/** Reads a numeric tar header field: octal text, or base-256 when the high bit is set. */
function numberField(header: Buffer, start: number, length: number): number {
  const field = header.subarray(start, start + length);
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = textField(header, start, length).trim();
  return text === '' ? 0 : parseInt(text, 8);
}

/** Reads the `path` and `size` records of a pax extended header. */
function paxRecords(body: Buffer): { path?: string; size?: number } {
  const records: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(body.subarray(offset, space).toString('utf8'), 10);
    if (!(length > 0)) break;
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === 'path') records.path = value;
    if (key === 'size') records.size = Number(value);
    offset += length;
  }
  return records;
}

/**
 * The entry's path inside the copy, with its first `dropped` folders left
 * out: a GitHub archive wraps every file in one top-level folder, and so
 * does a library's source archive. Undefined for those folders themselves
 * and for any path that is absolute or climbs out of the copy.
 */
function archivePath(entryPath: string, dropped: number): string | undefined {
  if (entryPath.startsWith('/')) return undefined;
  const segments = entryPath.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length <= dropped || segments.includes('..')) return undefined;
  return segments.slice(dropped).join('/');
}

/** How much an archive may unpack to; far above any real repository or library. */
export interface ExtractLimits {
  /** The most bytes all regular files together may take. */
  maxBytes?: number;
}

/** The default cap on what one archive unpacks to: 1 GiB. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

/** Where an archive's entries land: the root, its folders, and what was written. */
interface Destination {
  root: string;
  dirs: Set<string>;
  result: ExtractedArchive;
  /** Bytes still allowed before the archive is refused. */
  budget: number;
}

function destination(dir: string, limits: ExtractLimits): Destination {
  const root = resolve(dir);
  return { root, dirs: new Set([root]), result: { files: 0, skipped: [] }, budget: limits.maxBytes ?? MAX_UNPACKED_BYTES };
}

const TOO_LARGE = 'the archive unpacks to more than the companion allows; nothing of it is kept';

/**
 * Writes one regular file at its path inside the root, read-only and never
 * executable; a path that would leave the root is skipped. Throws once the
 * archive's files exceed the byte budget.
 */
async function writeEntry(into: Destination, entryPath: string, relative: string | undefined, content: Uint8Array): Promise<void> {
  const { root, dirs, result } = into;
  const target = relative === undefined ? undefined : resolve(root, relative);
  if (target === undefined || !target.startsWith(root + sep)) {
    result.skipped.push(`${entryPath}: path leaves the copy`);
    return;
  }
  into.budget -= content.length;
  if (into.budget < 0) throw new Error(TOO_LARGE);

  await mkdir(dirname(target), { recursive: true });
  for (let parent = dirname(target); parent.startsWith(root + sep); parent = dirname(parent)) {
    dirs.add(parent);
  }
  try {
    await writeFile(target, content, { mode: READ_ONLY_FILE, flag: 'wx' });
    result.files++;
  } catch (error) {
    // Two paths that differ only in case land on one file on a
    // case-insensitive file system; the first one wins.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    result.skipped.push(`${relative}: another entry already wrote this path`);
  }
}

/** Makes every folder written read-only, deepest first, so none turns read-only before its children. */
async function sealFolders(into: Destination): Promise<ExtractedArchive> {
  const ordered = [...into.dirs].sort((a, b) => b.split(sep).length - a.split(sep).length);
  for (const directory of ordered) {
    await chmod(directory, READ_ONLY_DIR);
  }
  return into.result;
}

/**
 * Extracts a gzipped tarball of one commit, as GitHub serves it, into
 * `dir` as a read-only copy. A library's source archive is laid out the
 * same way, under one top-level folder.
 *
 * Only regular files are written, each read-only and never executable;
 * symbolic links, hard links and special files are skipped and never
 * followed, and entries whose path would leave `dir` are refused. Once
 * every file is written, the directories become read-only too.
 */
export async function extractTarball(
  archive: AsyncIterable<Uint8Array>,
  dir: string,
  limits: ExtractLimits = {},
): Promise<ExtractedArchive> {
  const into = destination(dir, limits);
  const source = Readable.from(archive);
  const gunzip = createGunzip();
  source.on('error', (error) => gunzip.destroy(error));
  const reader = byteReader(source.pipe(gunzip));
  try {
    await extractEntries(reader, into);
    return await sealFolders(into);
  } finally {
    await reader.close();
    source.destroy();
  }
}

/**
 * Extracts a ZIP archive, such as a Python wheel, into `dir` as a
 * read-only copy, keeping every path as the archive has it. The same
 * rules as {@link extractTarball} hold: regular files only, each
 * read-only; symbolic links and special files skipped, never followed;
 * paths that would leave `dir` refused; the folders read-only at the end.
 */
export async function extractZip(bytes: Uint8Array, dir: string, limits: ExtractLimits = {}): Promise<ExtractedArchive> {
  const into = destination(dir, limits);
  const entries = readZipEntries(bytes);
  const declared = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (declared > into.budget) throw new Error(TOO_LARGE);
  await mkdir(into.root, { recursive: true });
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const type = entry.unixMode & FILE_TYPE_BITS;
    if (type !== 0 && type !== REGULAR_FILE) {
      into.result.skipped.push(`${entry.name}: not a regular file`);
      continue;
    }
    await writeEntry(into, entry.name, archivePath(entry.name, 0), entry.read());
  }
  return sealFolders(into);
}

/**
 * Writes downloaded files, such as a library's source files fetched one
 * by one, into `dir` as a read-only copy, by their forward-slash paths.
 * The same rules as {@link extractZip} hold: each file read-only, paths
 * that would leave `dir` refused, the folders read-only at the end.
 */
export async function writeReadOnlyFiles(
  files: readonly { path: string; content: Uint8Array }[],
  dir: string,
  limits: ExtractLimits = {},
): Promise<ExtractedArchive> {
  const into = destination(dir, limits);
  await mkdir(into.root, { recursive: true });
  for (const file of files) await writeEntry(into, file.path, archivePath(file.path, 0), file.content);
  return sealFolders(into);
}

/** The file-type bits of a Unix mode, and the value that marks a regular file. */
const FILE_TYPE_BITS = 0o170000;
const REGULAR_FILE = 0o100000;

/** Writes every entry of the tar stream. */
async function extractEntries({ read }: ByteReader, into: Destination): Promise<void> {
  let pending: { path?: string; size?: number } = {};

  for (;;) {
    const header = await read(BLOCK);
    if (header === undefined || header.every((byte) => byte === 0)) break;

    const type = String.fromCharCode(header[156]!);
    const size =
      !METADATA_TYPES.has(type) && pending.size !== undefined
        ? pending.size
        : numberField(header, 124, 12);
    const body = await read(Math.ceil(size / BLOCK) * BLOCK);
    if (body === undefined) throw new Error('the archive ends in the middle of an entry');
    const content = body.subarray(0, size);

    if (type === 'x') {
      pending = paxRecords(content);
      continue;
    }
    if (type === 'L') {
      pending = { ...pending, path: textField(content, 0, content.length) };
      continue;
    }
    if (type === 'g' || type === 'K') continue;

    const prefix = textField(header, 345, 155);
    const name = textField(header, 0, 100);
    const entryPath = pending.path ?? (prefix === '' ? name : `${prefix}/${name}`);
    pending = {};

    if (type === '5') continue;
    const relative = archivePath(entryPath, 1);
    if (type !== '0' && type !== '\0') {
      into.result.skipped.push(`${relative ?? entryPath}: not a regular file`);
      continue;
    }
    await writeEntry(into, entryPath, relative, content);
  }
}

/**
 * The absolute path of a file inside a copy, from its forward-slash path
 * in the diff. Undefined when the path would leave the copy.
 */
export function pathInCopy(copyDir: string, relative: string): string | undefined {
  const root = resolve(copyDir);
  const target = resolve(root, ...relative.split('/'));
  return target.startsWith(root + sep) ? target : undefined;
}
