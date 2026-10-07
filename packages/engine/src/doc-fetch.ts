import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable, pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';

/**
 * How the engine downloads documentation inventories, which a pull
 * request's lock files steer: from the hosts PyPI names for a library's
 * documentation, PyPI itself and the .NET API reference. Every URL must
 * be https on a named host with no credentials and no port; every address
 * the name resolves to must be a public one, checked as the connection is
 * made, so no inventory is read from the reviewer's own machine or
 * network; no redirect is followed; and what is downloaded, and what it
 * inflates to, is capped. What arrives is data to parse, never run.
 */

/** Why a URL is not one the engine downloads documentation from; undefined when it is. */
export function docsUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'it is not a URL';
  }
  if (url.protocol !== 'https:') return 'it is not https';
  if (url.username !== '' || url.password !== '') return 'it carries credentials';
  if (url.port !== '') return 'it names a port';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return 'it names an address rather than a host';
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'it names no public host';
  }
  return undefined;
}

/** The addresses no inventory is read from: loopback, private networks, link-local, and the other reserved ranges. */
const NOT_PUBLIC = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 127],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
})();

/** True when an address is a public one: not loopback, private, link-local or otherwise reserved, an IPv4 address mapped into IPv6 judged as itself. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolves a host name to every address it has, as `dns.lookup` does. */
export type ResolveAll = (hostname: string, options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * A `lookup` for the connection that resolves the host and refuses it
 * unless every address it has is public, so the address checked is the
 * one connected to.
 */
export function publicLookup(resolve: ResolveAll = dnsLookup as ResolveAll) {
  return (hostname: string, options: { all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const refused = addresses.find((each) => !isPublicAddress(each.address));
      if (addresses.length === 0 || refused !== undefined) {
        return callback(Object.assign(new Error(`${hostname} resolves to ${refused?.address ?? 'no address'}, which is not a public address`), { code: 'ENOTPUBLIC' }), '', 0);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** How long one documentation download may take. */
const DOCS_TIMEOUT_MS = 60_000;

/**
 * The engine's own fetch for documentation: a GET over https that
 * connects only to public addresses, follows no redirect — a redirect is
 * answered as itself, with no body — and gives up after a minute. It is
 * shaped as `fetch` so tests can stand a recorded one in its place.
 */
export function publicDocsFetch(resolve?: ResolveAll): typeof fetch {
  const lookup = publicLookup(resolve);
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const problem = docsUrlProblem(url);
    if (problem !== undefined) throw new Error(`not a URL documentation is read from: ${problem}`);
    return new Promise<Response>((resolveResponse, reject) => {
      const outgoing = request(url, { method: 'GET', lookup, headers: { 'accept-encoding': 'gzip', 'user-agent': 'second-look' } }, (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          incoming.resume();
          resolveResponse(new Response(null, { status: status >= 200 && status <= 599 ? status : 502 }));
          return;
        }
        resolveResponse(new Response(Readable.toWeb(incoming) as ReadableStream, { status }));
      });
      outgoing.setTimeout(DOCS_TIMEOUT_MS, () => outgoing.destroy(new Error(`${url} took longer than ${DOCS_TIMEOUT_MS / 1000} seconds`)));
      outgoing.on('error', reject);
      outgoing.end();
    });
  }) as typeof fetch;
}

/** What one download may take as it arrives, and once inflated. */
export interface DownloadLimits {
  downloaded: number;
  inflated: number;
}

/** The bytes as they arrive, refusing more than `limit` of them. */
async function* capped(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, limit: number, what: string): AsyncGenerator<Uint8Array> {
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new Error(`${what} is larger than the ${limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MiB` : `${limit} bytes`} the companion reads`);
    yield chunk;
  }
}

/** The bytes again, the first chunk put back after it was looked at. */
async function* withFirst(first: Uint8Array, rest: AsyncIterator<Uint8Array>): AsyncGenerator<Uint8Array> {
  yield first;
  for (let next = await rest.next(); !next.done; next = await rest.next()) yield next.value;
}

/**
 * A downloaded body as it streams in, gzip-inflated when it arrives
 * gzipped, the download and what it inflates to each capped. Answers
 * undefined for a 404 and throws for any other answer but a 2xx, a
 * redirect included.
 */
export async function downloadBody(response: Response, what: string, limits: DownloadLimits): Promise<AsyncIterable<Uint8Array> | undefined> {
  if (response.status === 404) return undefined;
  if (!response.ok || response.body === null) throw new Error(`the download of ${what} failed (HTTP ${response.status}${response.status >= 300 && response.status < 400 ? ', a redirect, which is not followed' : ''})`);
  const raw = capped(response.body as unknown as AsyncIterable<Uint8Array>, limits.downloaded, what)[Symbol.asyncIterator]();
  const first = await raw.next();
  if (first.done) return capped([], limits.inflated, what);
  const bytes = withFirst(first.value, raw);
  if (first.value[0] !== 0x1f || first.value[1] !== 0x8b) return capped(bytes, limits.inflated, what);
  const inflated = pipeline(Readable.from(bytes), createGunzip(), () => undefined);
  return capped(inflated, limits.inflated, `${what}, inflated,`);
}

/** Reads a whole stream into one buffer. */
export async function readAll(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
