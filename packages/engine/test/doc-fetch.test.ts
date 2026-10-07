import type { LookupAddress } from 'node:dns';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { docsUrlProblem, downloadBody, isPublicAddress, publicDocsFetch, publicLookup, readAll, type ResolveAll } from '../src/doc-fetch.js';

const LIMITS = { downloaded: 1024, inflated: 4096 };

/** A resolver that answers every name with the given addresses, as `dns.lookup` with `all` does. */
function resolvingTo(...addresses: string[]): ResolveAll {
  return (_hostname, _options, callback) => callback(null, addresses.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 })));
}

function lookUp(resolve: ResolveAll, all = false): Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[] }> {
  return new Promise((done) => publicLookup(resolve)('docs.example.org', { all }, (error, address) => done({ error, address })));
}

describe('docsUrlProblem', () => {
  it('accepts an https address on a named host', () => {
    expect(docsUrlProblem('https://www.attrs.org/en/23.1.0/objects.inv')).toBeUndefined();
  });

  it.each([
    ['http://www.attrs.org/objects.inv', 'it is not https'],
    ['ftp://www.attrs.org/objects.inv', 'it is not https'],
    ['https://user:secret@www.attrs.org/objects.inv', 'it carries credentials'],
    ['https://www.attrs.org:8443/objects.inv', 'it names a port'],
    ['https://127.0.0.1/objects.inv', 'it names an address rather than a host'],
    ['https://[::1]/objects.inv', 'it names an address rather than a host'],
    ['https://169.254.169.254/latest/meta-data', 'it names an address rather than a host'],
    ['https://localhost/objects.inv', 'it names no public host'],
    ['https://docs.localhost/objects.inv', 'it names no public host'],
    ['https://intranet/objects.inv', 'it names no public host'],
    ['https://printer.local/objects.inv', 'it names no public host'],
    ['not a url', 'it is not a URL'],
  ])('refuses %s: %s', (url, problem) => {
    expect(docsUrlProblem(url)).toBe(problem);
  });
});

describe('isPublicAddress', () => {
  it.each(['151.101.0.223', '13.107.246.40', '2606:4700::6810:84e5'])('takes %s as public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not an address'])(
    'refuses %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
});

describe('publicLookup', () => {
  it('connects to a host whose every address is public', async () => {
    expect(await lookUp(resolvingTo('151.101.0.223'))).toEqual({ error: null, address: '151.101.0.223' });
    expect((await lookUp(resolvingTo('151.101.0.223', '2606:4700::6810:84e5'), true)).address).toHaveLength(2);
  });

  it('refuses a host with any loopback, private or link-local address, as the connection is made', async () => {
    for (const address of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '::1']) {
      const { error } = await lookUp(resolvingTo('151.101.0.223', address));
      expect(error?.message).toBe(`docs.example.org resolves to ${address}, which is not a public address`);
    }
  });

  it('refuses a host before any connection when its address is not public', async () => {
    const fetchDocs = publicDocsFetch(resolvingTo('127.0.0.1'));
    await expect(fetchDocs('https://docs.example.org/objects.inv')).rejects.toThrow(/not a public address/);
    await expect(fetchDocs('http://docs.example.org/objects.inv')).rejects.toThrow(/not a URL documentation is read from: it is not https/);
  });
});

describe('downloadBody', () => {
  it('answers a 404 with nothing, and refuses a redirect and any other failure', async () => {
    expect(await downloadBody(new Response('gone', { status: 404 }), 'the inventory', LIMITS)).toBeUndefined();
    await expect(downloadBody(new Response(null, { status: 302 }), 'the inventory', LIMITS)).rejects.toThrow(/HTTP 302, a redirect, which is not followed/);
    await expect(downloadBody(new Response('no', { status: 500 }), 'the inventory', LIMITS)).rejects.toThrow(/HTTP 500/);
  });

  it('reads a body as sent, and inflates one sent gzipped', async () => {
    expect((await readAll((await downloadBody(new Response('plain text'), 'the map', LIMITS))!)).toString()).toBe('plain text');
    const gzipped = gzipSync(Buffer.from('{"references":[]}'));
    expect((await readAll((await downloadBody(new Response(gzipped), 'the map', LIMITS))!)).toString()).toBe('{"references":[]}');
    expect((await readAll((await downloadBody(new Response(''), 'the map', LIMITS))!)).length).toBe(0);
  });

  it('refuses a download larger than its cap, and one that inflates past its cap', async () => {
    const read = async (body: string | Buffer, what: string): Promise<Buffer> => readAll((await downloadBody(new Response(body), what, LIMITS))!);
    await expect(read('x'.repeat(2048), 'the inventory')).rejects.toThrow('the inventory is larger than the 1024 bytes the companion reads');
    const bomb = gzipSync(Buffer.alloc(64 * 1024));
    expect(bomb.length).toBeLessThan(LIMITS.downloaded);
    await expect(read(bomb, 'the map')).rejects.toThrow('the map, inflated, is larger than the 4096 bytes the companion reads');
  });
});
