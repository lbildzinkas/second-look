import { createHash } from 'node:crypto';
import { extractTarball } from './archive.js';
import { folderName, landLibrary } from './ecosystem-fetch.js';
import type { LibraryDownload, LibraryFetchOptions } from './library-fetch.js';
import { download } from './nuget-fetch.js';
import type { NamedRepository } from './protocol.js';

/**
 * The named-repository route of the library fetch (ADR 0003): when nothing
 * in the head copy pins a library a fetch can check, the agent may name
 * the library's public repository and the tag of the version the project
 * uses, and the companion downloads that tag's archive itself, only from
 * GitHub's or GitLab's own hosts. Nothing pins what it downloads and the
 * tag can move, so its evidence is a named repository's, weaker than
 * pinned source, and labelled so wherever it is used. Nothing is built,
 * installed or run.
 */

/** The hosts a named repository may be on, and nowhere else. */
const REPOSITORY_HOSTS = new Set(['github.com', 'gitlab.com']);

/** One path segment of a repository's URL: an owner, a group or a name. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** A tag as a URL may hold it: Git's ref characters, with nothing that steers a path. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.+/-]{0,199}$/;

/** A repository the fetch can download from, as its host and path segments, and the tag. */
interface Archive {
  url: string;
  host: string;
  segments: string[];
  tag: string;
}

/** The named repository as the fetch downloads it, or a plain reason it cannot be fetched. */
function archiveOf(named: NamedRepository): Archive | string {
  let url: URL;
  try {
    url = new URL(named.url.trim());
  } catch {
    return `${JSON.stringify(named.url)} is not a URL`;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || !REPOSITORY_HOSTS.has(host)) {
    return `${url.origin} is not one of the hosts a named repository is fetched from (${[...REPOSITORY_HOSTS].join(', ')}), over https`;
  }
  const segments = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '').split('/').slice(1);
  if (segments.length < 2 || (host === 'github.com' && segments.length !== 2) || !segments.every((segment) => SEGMENT.test(segment) && !segment.endsWith('.'))) {
    return `${url.href} names no repository on ${host}`;
  }
  const tag = named.tag.trim().replace(/^refs\/tags\//, '');
  if (!TAG.test(tag) || tag.includes('..') || tag.includes('//') || /[/.]$|\.lock$/.test(tag)) return `${JSON.stringify(named.tag)} is not a tag a fetch can download`;
  return { url: `https://${host}/${segments.join('/')}`, host, segments, tag };
}

/** Why a named repository cannot be fetched, or undefined when it can. */
export function namedRepositoryProblem(named: NamedRepository): string | undefined {
  const archive = archiveOf(named);
  return typeof archive === 'string' ? archive : undefined;
}

/** The tag's gzipped archive, on the forge's own download host. */
function archiveUrl({ host, segments, tag }: Archive): string {
  const ref = tag.split('/').map(encodeURIComponent).join('/');
  if (host === 'github.com') return `https://codeload.github.com/${segments.join('/')}/tar.gz/refs/tags/${ref}`;
  return `https://gitlab.com/${segments.join('/')}/-/archive/${ref}/${segments.at(-1)}-${tag.replace(/\//g, '-')}.tar.gz`;
}

/**
 * Fetches one library from the repository and tag the agent named:
 * downloads the tag's archive from the forge's own download host and
 * untars it read-only into its own folder of the library cache, never
 * built, installed or run. No lock file pins it, so no hash is checked:
 * the fetch records the archive's SHA-256 and says that its evidence is a
 * named repository's, weaker than pinned source.
 */
export async function fetchNamedRepository(library: string, named: NamedRepository, options: LibraryFetchOptions): Promise<LibraryDownload> {
  const archive = archiveOf(named);
  if (typeof archive === 'string') throw new Error(`the repository named for ${library} cannot be fetched: ${archive}; nothing was downloaded`);
  const fetchFn = options.fetch ?? fetch;
  const key = createHash('sha256').update(`${archive.url}\n${archive.tag}`).digest('hex').slice(0, 12);
  return landLibrary(options.librariesDir, `repository-${folderName(archive.segments.at(-1)!)}-${folderName(archive.tag)}-${key}`, async () => {
    const url = archiveUrl(archive);
    const file = `${archive.segments.at(-1)}-${archive.tag.replace(/\//g, '-')}.tar.gz`;
    const bytes = await download(url, file, fetchFn);
    if (bytes === undefined) throw new Error(`${archive.url} has no tag ${archive.tag}; nothing was downloaded`);
    return {
      landed: {
        file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        archive: 'named repository',
        note:
          `Fetched from ${archive.url} at tag ${archive.tag}, which the agent named for ${library}: nothing in the head copy pins it, and nothing ties ` +
          'that tag to the version the project uses, so this is a named repository, weaker evidence than pinned source.',
      },
      write: (dir) => extractTarball((async function* () { yield bytes; })(), dir, { maxBytes: 1024 * 1024 * 1024 }),
    };
  });
}
