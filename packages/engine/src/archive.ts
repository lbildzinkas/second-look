import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

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
 * The entry's path inside the copy: the single top-level folder GitHub
 * wraps every archive in is dropped. Undefined for the folder itself and
 * for any path that is absolute or climbs out of the copy.
 */
function copyPath(entryPath: string): string | undefined {
  if (entryPath.startsWith('/')) return undefined;
  const segments = entryPath.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length < 2 || segments.includes('..')) return undefined;
  return segments.slice(1).join('/');
}

/**
 * Extracts a gzipped tarball of one commit, as GitHub serves it, into
 * `dir` as a read-only copy.
 *
 * Only regular files are written, each read-only and never executable;
 * symbolic links, hard links and special files are skipped and never
 * followed, and entries whose path would leave `dir` are refused. Once
 * every file is written, the directories become read-only too.
 */
export async function extractTarball(
  archive: AsyncIterable<Uint8Array>,
  dir: string,
): Promise<ExtractedArchive> {
  const root = resolve(dir);
  const source = Readable.from(archive);
  const gunzip = createGunzip();
  source.on('error', (error) => gunzip.destroy(error));
  const reader = byteReader(source.pipe(gunzip));
  try {
    const directories = await extractEntries(reader, root);
    // Deepest first, so no directory turns read-only before its children.
    const ordered = [...directories.dirs].sort((a, b) => b.split(sep).length - a.split(sep).length);
    for (const directory of ordered) {
      await chmod(directory, READ_ONLY_DIR);
    }
    return directories.result;
  } finally {
    await reader.close();
    source.destroy();
  }
}

/** Writes every entry of the tar stream; returns the directories it made. */
async function extractEntries(
  { read }: ByteReader,
  root: string,
): Promise<{ result: ExtractedArchive; dirs: Set<string> }> {
  const result: ExtractedArchive = { files: 0, skipped: [] };
  const dirs = new Set<string>([root]);
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
    const relative = copyPath(entryPath);
    if (type !== '0' && type !== '\0') {
      result.skipped.push(`${relative ?? entryPath}: not a regular file`);
      continue;
    }
    if (relative === undefined) {
      result.skipped.push(`${entryPath}: path leaves the copy`);
      continue;
    }
    const target = resolve(root, relative);
    if (!target.startsWith(root + sep)) {
      result.skipped.push(`${entryPath}: path leaves the copy`);
      continue;
    }

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
  return { result, dirs };
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
