import { inflateRawSync } from 'node:zlib';

/** The hash algorithms a portable PDB names for its source documents. */
export type DocumentHashAlgorithm = 'SHA-1' | 'SHA-256' | 'unknown' | 'none';

/** One source document a portable PDB records. */
export interface SourceDocument {
  /** The document's path as the compiler saw it, such as `/_/src/Guard.cs`. */
  name: string;
  /** The algorithm of `hash`: `none` when the PDB records no hash. */
  hashAlgorithm: DocumentHashAlgorithm;
  /** The hash of the source file's bytes, as lowercase hex; empty when none. */
  hash: string;
}

/** What the engine reads from one portable PDB. */
export interface PortablePdb {
  documents: SourceDocument[];
  /** The Source Link JSON text, or null when the PDB carries none. */
  sourceLink: string | null;
}

/** Thrown for any input that is not a well-formed portable PDB, assembly or package. */
export class PdbFormatError extends Error {
  override name = 'PdbFormatError';
}

const SHA1_GUID = 'ff1816ec-aa5e-4d10-87f7-6f4963833460';
const SHA256_GUID = '8829d00f-11b8-4213-878b-770e8597ac16';
const SOURCE_LINK_GUID = 'cc110556-a091-4d38-9fec-25ab9a351a6a';
const WINDOWS_PDB_MAGIC = 'Microsoft C/C++ MSF 7.00';

/** Debug directory entry type of a deflated portable PDB inside an assembly. */
const EMBEDDED_PORTABLE_PDB = 17;
/** Signature in front of an embedded portable PDB: `MPDB`. */
const EMBEDDED_PDB_SIGNATURE = 0x4244504d;
/** The largest file the reader inflates: far above any real PDB or assembly. */
const MAX_INFLATED_SIZE = 256 * 1024 * 1024;
/** The longest document name the reader assembles from its parts. */
const MAX_DOCUMENT_NAME = 0x10000;
/** The most text all document names together may take: far above any real PDB. */
const MAX_DOCUMENT_NAMES_TOTAL = 64 * 1024 * 1024;
/** The hash length each known algorithm produces, in bytes. */
const HASH_LENGTHS: Partial<Record<DocumentHashAlgorithm, number>> = {
  'SHA-1': 20,
  'SHA-256': 32,
};
/** The longest hash the reader keeps for an algorithm it does not know. */
const MAX_UNKNOWN_HASH = 64;
/** Signature of an ECMA-335 metadata root: `BSJB`. */
const METADATA_SIGNATURE = 0x424a5342;

// Metadata table numbers, from ECMA-335 and the portable PDB specification.
const MODULE = 0x00;
const METHOD_DEF = 0x06;
const DOCUMENT = 0x30;
const METHOD_DEBUG_INFORMATION = 0x31;
const LOCAL_SCOPE = 0x32;
const LOCAL_VARIABLE = 0x33;
const LOCAL_CONSTANT = 0x34;
const IMPORT_SCOPE = 0x35;
const STATE_MACHINE_METHOD = 0x36;
const CUSTOM_DEBUG_INFORMATION = 0x37;

/** The tables a HasCustomDebugInformation coded index can point into. */
const HAS_CUSTOM_DEBUG_INFORMATION = [
  METHOD_DEF, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, MODULE, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b,
  0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b, DOCUMENT, LOCAL_SCOPE, LOCAL_VARIABLE,
  LOCAL_CONSTANT, IMPORT_SCOPE,
];

function fail(message: string): never {
  throw new PdbFormatError(message);
}

/**
 * A bounds-checked view over bytes: every read past the end throws a
 * PdbFormatError naming what was being read, so no input can crash or
 * overrun the reader.
 */
class ByteView {
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    private readonly what: string,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  check(offset: number, length: number, field: string): void {
    if (offset < 0 || length < 0 || offset + length > this.bytes.length) {
      fail(`${this.what}: ${field} lies outside the data`);
    }
  }

  u8(offset: number, field: string): number {
    this.check(offset, 1, field);
    return this.bytes[offset]!;
  }

  u16(offset: number, field: string): number {
    this.check(offset, 2, field);
    return this.view.getUint16(offset, true);
  }

  u32(offset: number, field: string): number {
    this.check(offset, 4, field);
    return this.view.getUint32(offset, true);
  }

  /** A little-endian index of 2 or 4 bytes. */
  index(offset: number, size: number, field: string): number {
    return size === 2 ? this.u16(offset, field) : this.u32(offset, field);
  }

  slice(offset: number, length: number, field: string): Uint8Array {
    this.check(offset, length, field);
    return this.bytes.subarray(offset, offset + length);
  }
}

/** Reads an ECMA-335 compressed unsigned integer: its value and its length. */
function readCompressed(view: ByteView, offset: number, field: string): [number, number] {
  const first = view.u8(offset, field);
  if ((first & 0x80) === 0) {
    return [first, 1];
  }
  if ((first & 0xc0) === 0x80) {
    return [((first & 0x3f) << 8) | view.u8(offset + 1, field), 2];
  }
  if ((first & 0xe0) === 0xc0) {
    const value =
      ((first & 0x1f) * 0x1000000) +
      (view.u8(offset + 1, field) << 16) +
      (view.u8(offset + 2, field) << 8) +
      view.u8(offset + 3, field);
    return [value, 4];
  }
  return fail(`${field}: invalid compressed integer`);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Formats 16 GUID heap bytes as a lowercase GUID string. */
function formatGuid(bytes: Uint8Array): string {
  const h = hex(bytes);
  const swap = (s: string): string => s.match(/../g)!.reverse().join('');
  const [a, b, c] = [swap(h.slice(0, 8)), swap(h.slice(8, 12)), swap(h.slice(12, 16))];
  return `${a}-${b}-${c}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** True when bit `bit` of the 64-bit mask made of `low` and `high` is set. */
function bitSet(low: number, high: number, bit: number): boolean {
  return (((bit < 32 ? low : high) >>> (bit % 32)) & 1) === 1;
}

/** The heaps and the table layout of one metadata root. */
interface Metadata {
  view: ByteView;
  blobs: ByteView;
  guids: ByteView;
  /** Byte offset of each present table in `view`, and its row count and size. */
  tables: Map<number, { offset: number; rows: number; rowSize: number }>;
  heapSizes: { string: number; guid: number; blob: number };
}

/** Reads the stream headers of a metadata root into named streams. */
function readStreams(view: ByteView): Map<string, ByteView> {
  if (view.u32(0, 'metadata signature') !== METADATA_SIGNATURE) {
    const head = view.bytes.subarray(0, WINDOWS_PDB_MAGIC.length);
    if (Buffer.from(head).toString('latin1') === WINDOWS_PDB_MAGIC) {
      fail('this is a Windows PDB, not a portable PDB');
    }
    fail('not a portable PDB: the metadata signature is missing');
  }
  const versionLength = view.u32(12, 'metadata version length');
  let offset = 16 + versionLength;
  const count = view.u16(offset + 2, 'stream count');
  offset += 4;
  const streams = new Map<string, ByteView>();
  for (let i = 0; i < count; i++) {
    const start = view.u32(offset, 'stream offset');
    const size = view.u32(offset + 4, 'stream size');
    let end = offset + 8;
    while (view.u8(end, 'stream name') !== 0) {
      end++;
      if (end - offset > 40) {
        fail('stream name is not terminated');
      }
    }
    const name = Buffer.from(view.bytes.subarray(offset + 8, end)).toString('latin1');
    view.check(start, size, `stream ${name}`);
    streams.set(name, new ByteView(view.slice(start, size, `stream ${name}`), `stream ${name}`));
    offset = offset + 8 + ((end - offset - 8 + 4) & ~3);
  }
  return streams;
}

/**
 * Lays out the tables of a portable PDB's `#~` stream. Row sizes depend on
 * every table's row count, including the type system tables the `#Pdb`
 * stream counts for the assembly it describes.
 */
function readMetadata(bytes: Uint8Array): Metadata {
  const view = new ByteView(bytes, 'portable PDB');
  const streams = readStreams(view);
  const pdb = streams.get('#Pdb') ?? fail('not a portable PDB: the #Pdb stream is missing');
  const tableStream = streams.get('#~') ?? fail('portable PDB: the #~ table stream is missing');
  const empty = new ByteView(new Uint8Array(0), 'empty heap');

  const rowCounts = new Array<number>(64).fill(0);
  const referencedLow = pdb.u32(24, 'referenced tables');
  const referencedHigh = pdb.u32(28, 'referenced tables');
  let at = 32;
  for (let table = 0; table < 64; table++) {
    if (bitSet(referencedLow, referencedHigh, table)) {
      rowCounts[table] = pdb.u32(at, 'type system row count');
      at += 4;
    }
  }

  const heapFlags = tableStream.u8(6, 'heap sizes');
  const validLow = tableStream.u32(8, 'valid tables');
  const validHigh = tableStream.u32(12, 'valid tables');
  const present: number[] = [];
  for (let table = 0; table < 64; table++) {
    if (bitSet(validLow, validHigh, table)) {
      present.push(table);
    }
  }
  at = 24;
  for (const table of present) {
    rowCounts[table] = tableStream.u32(at, 'table row count');
    at += 4;
  }
  if (present.some((table) => table < DOCUMENT)) {
    fail('portable PDB: the #~ stream holds type system tables');
  }

  const heapSizes = {
    string: heapFlags & 0x01 ? 4 : 2,
    guid: heapFlags & 0x02 ? 4 : 2,
    blob: heapFlags & 0x04 ? 4 : 2,
  };
  const index = (table: number): number => (rowCounts[table]! < 0x10000 ? 2 : 4);
  const codedMax = Math.max(...HAS_CUSTOM_DEBUG_INFORMATION.map((table) => rowCounts[table]!));
  const rowSizes = new Map<number, number>([
    [DOCUMENT, heapSizes.blob * 2 + heapSizes.guid * 2],
    [METHOD_DEBUG_INFORMATION, index(DOCUMENT) + heapSizes.blob],
    [
      LOCAL_SCOPE,
      index(METHOD_DEF) + index(IMPORT_SCOPE) + index(LOCAL_VARIABLE) + index(LOCAL_CONSTANT) + 8,
    ],
    [LOCAL_VARIABLE, 4 + heapSizes.string],
    [LOCAL_CONSTANT, heapSizes.string + heapSizes.blob],
    [IMPORT_SCOPE, index(IMPORT_SCOPE) + heapSizes.blob],
    [STATE_MACHINE_METHOD, index(METHOD_DEF) * 2],
    [CUSTOM_DEBUG_INFORMATION, (codedMax < 1 << 11 ? 2 : 4) + heapSizes.guid + heapSizes.blob],
  ]);

  const tables: Metadata['tables'] = new Map();
  for (const table of present) {
    const rowSize = rowSizes.get(table);
    if (rowSize === undefined) {
      break; // Tables are stored in order; the ones after these are not read.
    }
    const rows = rowCounts[table]!;
    tableStream.check(at, rows * rowSize, `table 0x${table.toString(16)}`);
    tables.set(table, { offset: at, rows, rowSize });
    at += rows * rowSize;
  }

  return {
    view: tableStream,
    blobs: streams.get('#Blob') ?? empty,
    guids: streams.get('#GUID') ?? empty,
    tables,
    heapSizes,
  };
}

function readBlob(meta: Metadata, index: number): Uint8Array {
  if (index === 0) {
    return new Uint8Array(0);
  }
  const [length, size] = readCompressed(meta.blobs, index, 'blob length');
  return meta.blobs.slice(index + size, length, 'blob');
}

function readGuid(meta: Metadata, index: number): string | null {
  if (index === 0) {
    return null;
  }
  return formatGuid(meta.guids.slice((index - 1) * 16, 16, 'GUID'));
}

/**
 * Reads a document name blob: a separator character, then blob indexes of
 * UTF-8 parts joined by that separator.
 */
function readDocumentName(meta: Metadata, index: number): string {
  const blob = new ByteView(readBlob(meta, index), 'document name');
  const separator = blob.u8(0, 'document name separator');
  const parts: string[] = [];
  let length = 0;
  for (let at = 1; at < blob.bytes.length; ) {
    const [part, size] = readCompressed(blob, at, 'document name part');
    const text = Buffer.from(readBlob(meta, part)).toString('utf8');
    length += text.length + 1;
    if (length > MAX_DOCUMENT_NAME) {
      fail('portable PDB: a document name is implausibly long');
    }
    parts.push(text);
    at += size;
  }
  return parts.join(separator === 0 ? '' : String.fromCharCode(separator));
}

function hashAlgorithmOf(guid: string | null): DocumentHashAlgorithm {
  if (guid === null) {
    return 'none';
  }
  if (guid === SHA1_GUID) {
    return 'SHA-1';
  }
  return guid === SHA256_GUID ? 'SHA-256' : 'unknown';
}

/**
 * Reads a portable PDB: its source documents, each with its hash algorithm
 * and hash, and its Source Link JSON. Throws a PdbFormatError for any
 * malformed input.
 */
export function readPortablePdb(bytes: Uint8Array): PortablePdb {
  const meta = readMetadata(bytes);
  const { view, heapSizes } = meta;
  const field = (offset: number, size: number): number => view.index(offset, size, 'table row');

  const documents: SourceDocument[] = [];
  const documentTable = meta.tables.get(DOCUMENT);
  let namesTotal = 0;
  for (let row = 0; documentTable && row < documentTable.rows; row++) {
    let at = documentTable.offset + row * documentTable.rowSize;
    const name = readDocumentName(meta, field(at, heapSizes.blob));
    const algorithm = readGuid(meta, field((at += heapSizes.blob), heapSizes.guid));
    const hashAlgorithm = hashAlgorithmOf(algorithm);
    const hashIndex = field((at += heapSizes.guid), heapSizes.blob);
    const hash = hashAlgorithm === 'none' ? new Uint8Array(0) : readBlob(meta, hashIndex);
    const expected = HASH_LENGTHS[hashAlgorithm];
    if (expected !== undefined && hash.length !== expected) {
      fail(`portable PDB: a ${hashAlgorithm} hash has ${hash.length} bytes, expected ${expected}`);
    }
    namesTotal += name.length;
    if (hash.length > MAX_UNKNOWN_HASH || namesTotal > MAX_DOCUMENT_NAMES_TOTAL) {
      fail('portable PDB: the document table is implausibly large');
    }
    documents.push({ name, hashAlgorithm, hash: hex(hash) });
  }

  let sourceLink: string | null = null;
  const debugInfo = meta.tables.get(CUSTOM_DEBUG_INFORMATION);
  for (let row = 0; debugInfo && row < debugInfo.rows && sourceLink === null; row++) {
    const parentSize = debugInfo.rowSize - heapSizes.guid - heapSizes.blob;
    const at = debugInfo.offset + row * debugInfo.rowSize + parentSize;
    if (readGuid(meta, field(at, heapSizes.guid)) === SOURCE_LINK_GUID) {
      const value = readBlob(meta, field(at + heapSizes.guid, heapSizes.blob));
      sourceLink = Buffer.from(value).toString('utf8');
    }
  }

  return { documents, sourceLink };
}

/**
 * Finds the portable PDB embedded in a .NET assembly's debug directory and
 * inflates it. Returns null when the assembly embeds none; throws a
 * PdbFormatError when the assembly or its embedded PDB is malformed.
 */
export function readEmbeddedPdb(assembly: Uint8Array): Uint8Array | null {
  const view = new ByteView(assembly, 'assembly');
  if (view.u16(0, 'DOS signature') !== 0x5a4d) {
    fail('not an assembly: the MZ signature is missing');
  }
  const pe = view.u32(0x3c, 'PE header offset');
  if (view.u32(pe, 'PE signature') !== 0x4550) {
    fail('not an assembly: the PE signature is missing');
  }
  const sectionCount = view.u16(pe + 6, 'section count');
  const optional = pe + 24;
  const optionalSize = view.u16(pe + 20, 'optional header size');
  const magic = view.u16(optional, 'optional header magic');
  if (magic !== 0x10b && magic !== 0x20b) {
    fail('assembly: unknown optional header magic');
  }
  const directories = optional + (magic === 0x10b ? 96 : 112);
  const directoryCount = view.u32(directories - 4, 'data directory count');
  if (directoryCount <= 6) {
    return null;
  }
  const debugRva = view.u32(directories + 6 * 8, 'debug directory address');
  const debugSize = view.u32(directories + 6 * 8 + 4, 'debug directory size');
  if (debugSize === 0) {
    return null;
  }

  let debugOffset: number | undefined;
  for (let i = 0; i < sectionCount; i++) {
    const header = optional + optionalSize + i * 40;
    const virtualSize = view.u32(header + 8, 'section size');
    const virtualAddress = view.u32(header + 12, 'section address');
    const rawSize = view.u32(header + 16, 'section raw size');
    const rawOffset = view.u32(header + 20, 'section raw offset');
    const sectionEnd = virtualAddress + Math.max(virtualSize, rawSize);
    if (debugRva >= virtualAddress && debugRva < sectionEnd) {
      debugOffset = rawOffset + debugRva - virtualAddress;
      break;
    }
  }
  if (debugOffset === undefined) {
    fail('assembly: the debug directory lies in no section');
  }

  for (let entry = 0; entry < Math.floor(debugSize / 28); entry++) {
    const at = debugOffset + entry * 28;
    if (view.u32(at + 12, 'debug entry type') !== EMBEDDED_PORTABLE_PDB) {
      continue;
    }
    const size = view.u32(at + 16, 'embedded PDB size');
    const offset = view.u32(at + 24, 'embedded PDB offset');
    const data = new ByteView(view.slice(offset, size, 'embedded PDB'), 'embedded PDB');
    if (data.u32(0, 'embedded PDB signature') !== EMBEDDED_PDB_SIGNATURE) {
      fail('assembly: the embedded PDB signature is missing');
    }
    const deflated = data.slice(8, size - 8, 'embedded PDB data');
    return inflateExactly(deflated, data.u32(4, 'embedded PDB size'), 'embedded PDB');
  }
  return null;
}

/**
 * Inflates raw deflate data that must expand to exactly `size` bytes; the
 * output is capped at that size, and the size itself at 256 MiB, so a
 * deflate bomb cannot exhaust memory.
 */
export function inflateExactly(data: Uint8Array, size: number, what: string): Uint8Array {
  if (size === 0) {
    return new Uint8Array(0);
  }
  if (size > MAX_INFLATED_SIZE) {
    fail(`${what}: declares ${size} bytes, more than the 256 MiB this reader inflates`);
  }
  let inflated: Buffer;
  try {
    inflated = inflateRawSync(data, { maxOutputLength: size });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(
      `${what}: the compressed data is corrupt or exceeds its declared ${size} bytes (${reason})`,
    );
  }
  if (inflated.length !== size) {
    fail(`${what}: inflated to ${inflated.length} bytes, expected ${size}`);
  }
  return inflated;
}
