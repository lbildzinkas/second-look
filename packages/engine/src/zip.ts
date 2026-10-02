import { PdbFormatError, inflateExactly } from './pdb.js';

/** One file stored in a ZIP archive, such as a NuGet package. */
export interface ZipEntry {
  /** The entry's path inside the archive. */
  name: string;
  /** Inflates the entry's bytes; throws a PdbFormatError when they are corrupt. */
  read(): Uint8Array;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

function fail(message: string): never {
  throw new PdbFormatError(`package: ${message}`);
}

/**
 * Lists the files of a ZIP archive from its central directory. Only stored
 * and deflated entries can be read; ZIP64 and encrypted archives are
 * refused with a clear error.
 */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number): number =>
    at + 2 <= bytes.length ? view.getUint16(at, true) : fail('truncated archive');
  const u32 = (at: number): number =>
    at + 4 <= bytes.length ? view.getUint32(at, true) : fail('truncated archive');

  // The end record is the last 22 bytes, unless a comment of up to 64 KiB follows it.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end === -1) {
    fail('not a ZIP archive: the end of central directory record is missing');
  }
  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  let at = u32(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || at === 0xffffffff) {
    fail('ZIP64 archives are not supported');
  }
  if (at + directorySize > end) {
    fail('the central directory lies outside the archive');
  }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(at) !== CENTRAL_DIRECTORY_HEADER) {
      fail(`central directory entry ${i} is malformed`);
    }
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const compressedSize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const headerOffset = u32(at + 42);
    if (at + 46 + nameLength > bytes.length) {
      fail('truncated archive');
    }
    const name = Buffer.from(bytes.subarray(at + 46, at + 46 + nameLength)).toString('utf8');
    at += 46 + nameLength + u16(at + 30) + u16(at + 32);
    entries.push({
      name,
      read(): Uint8Array {
        if (flags & 0x1) {
          fail(`${name} is encrypted`);
        }
        if (u32(headerOffset) !== LOCAL_FILE_HEADER) {
          fail(`${name}: the local file header is missing`);
        }
        const start = headerOffset + 30 + u16(headerOffset + 26) + u16(headerOffset + 28);
        if (start + compressedSize > bytes.length) {
          fail(`${name} extends past the end of the archive`);
        }
        const data = bytes.subarray(start, start + compressedSize);
        if (method === 0) {
          return compressedSize === size ? data : fail(`${name}: stored sizes disagree`);
        }
        if (method !== 8) {
          fail(`${name} uses unsupported compression method ${method}`);
        }
        return inflateExactly(data, size, `package entry ${name}`);
      },
    });
  }
  return entries;
}
