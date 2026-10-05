import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** The folders never searched for a pin: dependencies, build output and hidden folders. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'bin', 'obj', 'packages']);

/** How deep and how wide the search for a pin goes in the head copy. */
const MAX_SEARCH_DEPTH = 6;
const MAX_SEARCHED_FILES = 5000;

/**
 * The files of the head copy whose name `wanted` accepts, by forward-slash
 * path, shallowest first and then by path: searched below the root, never
 * in dependency or build folders or hidden ones, and never through a
 * symbolic link.
 */
export async function pinFilesIn(root: string, wanted: (name: string) => boolean): Promise<string[]> {
  const found: string[][] = [];
  let seen = 0;
  let level = [''];
  for (let depth = 0; depth <= MAX_SEARCH_DEPTH && level.length > 0 && seen < MAX_SEARCHED_FILES; depth++) {
    const next: string[] = [];
    const here: string[] = [];
    for (const folder of level) {
      const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        seen++;
        const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
        // A symbolic link is neither a folder nor a file here, so none is followed.
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name.toLowerCase())) next.push(path);
        if (entry.isFile() && wanted(entry.name)) here.push(path);
      }
    }
    found.push(here.sort((a, b) => a.localeCompare(b)));
    level = next;
  }
  return found.flat();
}
