import {
  PdbFormatError,
  readEmbeddedPdb,
  readPortablePdb,
  type DocumentHashAlgorithm,
} from './pdb.js';
import { parseSourceLink, sourceLinkUrl } from './sourcelink.js';
import { readZipEntries } from './zip.js';

/** One source document with the URL its Source Link map gives it. */
export interface LinkedSourceDocument {
  name: string;
  hashAlgorithm: DocumentHashAlgorithm;
  hash: string;
  /** The Source Link URL of this document, or null when the map has none. */
  sourceLinkUrl: string | null;
}

/** One portable PDB found in a package, standalone or embedded in an assembly. */
export interface PackagePdb {
  /** The package entry the PDB came from: a .pdb file, or the assembly embedding it. */
  entry: string;
  embedded: boolean;
  documents: LinkedSourceDocument[];
  /** The Source Link JSON, parsed, or null when the PDB carries none. */
  sourceLink: unknown;
}

/** Reads one portable PDB and resolves each document's Source Link URL. */
function describePdb(entry: string, embedded: boolean, bytes: Uint8Array): PackagePdb {
  const pdb = readPortablePdb(bytes);
  const links = pdb.sourceLink === null ? [] : parseSourceLink(pdb.sourceLink);
  return {
    entry,
    embedded,
    documents: pdb.documents.map((document) => ({
      ...document,
      sourceLinkUrl: sourceLinkUrl(links, document.name),
    })),
    sourceLink: pdb.sourceLink === null ? null : JSON.parse(pdb.sourceLink),
  };
}

/** True when the bytes start with an assembly's `MZ` signature. */
function isAssembly(bytes: Uint8Array): boolean {
  return bytes[0] === 0x4d && bytes[1] === 0x5a;
}

/**
 * Reads one file that is a PDB or an assembly: null for an assembly that
 * embeds no portable PDB. Errors are prefixed with the file's name.
 */
function readSymbolFile(entry: string, bytes: Uint8Array): PackagePdb | null {
  try {
    if (!isAssembly(bytes)) {
      return describePdb(entry, false, bytes);
    }
    const embedded = readEmbeddedPdb(bytes);
    return embedded === null ? null : describePdb(entry, true, embedded);
  } catch (error) {
    if (error instanceof PdbFormatError) {
      throw new PdbFormatError(`${entry}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Lists every portable PDB in a package file — a NuGet package or symbols
 * package, or a single .pdb or assembly — with its source documents, their
 * hashes and Source Link URLs. Throws a PdbFormatError naming the file and
 * the problem for any malformed input.
 */
export function readPackagePdbs(fileName: string, bytes: Uint8Array): PackagePdb[] {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // `PK`
  if (!isZip) {
    const pdb = readSymbolFile(fileName, bytes);
    if (pdb === null) {
      throw new PdbFormatError(`${fileName}: the assembly embeds no portable PDB`);
    }
    return [pdb];
  }
  const pdbs: PackagePdb[] = [];
  for (const entry of readZipEntries(bytes)) {
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.pdb') && !lower.endsWith('.dll') && !lower.endsWith('.exe')) {
      continue;
    }
    const pdb = readSymbolFile(entry.name, entry.read());
    // Assemblies without an embedded PDB, such as reference assemblies, are skipped.
    if (pdb !== null) {
      pdbs.push(pdb);
    }
  }
  return pdbs;
}
