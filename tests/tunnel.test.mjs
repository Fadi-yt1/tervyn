// Exit countries: HTTP/1.1 over a raw socket through fake free proxies (CONNECT and SOCKS5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { fetchViaProxy, exitFetch } from '../gateway/tunnel.js';
import { createRemoteExits } from '../gateway/exits-remote.js';
import { createGateway } from '../gateway/core.js';
import { startFakeProxies } from './helpers/fake-proxies.mjs';

let site, sitePort, proxies;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// Node socket shaped like Cloudflare's connect() (plain TCP; TLS isn't needed for these tests).
async function openSocket(host, port) {
  const s = net.connect(port, host);
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
  return { readable: Readable.toWeb(s), writable: Writable.toWeb(s), close: () => s.destroy() };
}

before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/chunked') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('hello '); setTimeout(() => res.end('chunks'), 20); return; }
    if (u.pathname === '/gzip') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('x'.repeat(5000))); }
    if (u.pathname === '/len') { res.writeHead(201, { 'content-type': 'text/plain', 'content-length': '5', 'set-cookie': ['a=1', 'b=2'] }); return res.end('fixed'); }
    if (u.pathname === '/close') { res.socket.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nuntil close'); return; }
    if (u.pathname === '/post') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => res.end(`${req.method}:${b}:${req.headers['x-test']}`)); return; }
    if (u.pathname === '/redirect') { res.writeHead(302, { location: '/len' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head></head><body><a href="/len">x</a></body></html>');
  });
  sitePort = await listen(site);
  proxies = await startFakeProxies();
});
after(() => { site.close(); proxies.close(); });

const url = (p) => `http://127.0.0.1:${sitePort}${p}`;

test('chunked, gzip, fixed-length and close-delimited bodies through HTTP CONNECT', async () => {
  const p = { proto: 'http', address: '127.0.0.1', port: proxies.connectPort, code: 'US' };
  assert.equal(await (await fetchViaProxy(openSocket, p, url('/chunked'))).text(), 'hello chunks');
  assert.equal(await (await fetchViaProxy(openSocket, p, url('/gzip'))).text(), 'x'.repeat(5000));
  const len = await fetchViaProxy(openSocket, p, url('/len'));
  assert.equal(len.status, 201);
  assert.deepEqual(len.headers.getSetCookie(), ['a=1', 'b=2']);
  assert.equal(len.headers.get('x-tervyn-exit'), 'US');
  assert.equal(await len.text(), 'fixed');
  assert.equal(await (await fetchViaProxy(openSocket, p, url('/close'))).text(), 'until close');
  const red = await fetchViaProxy(openSocket, p, url('/redirect'));
  assert.equal(red.status, 302);
  assert.equal(red.headers.get('location'), '/len');
});

test('POST bodies and headers through SOCKS5', async () => {
  const p = { proto: 'socks5', address: '127.0.0.1', port: proxies.socksPort, code: 'CA' };
  const body = new TextEncoder().encode('a=1&b=2');
  const r = await fetchViaProxy(openSocket, p, url('/post'), { method: 'POST', headers: { 'x-test': 'yes' } }, body);
  assert.equal(await r.text(), 'POST:a=1&b=2:yes');
  assert.equal(r.headers.get('x-tervyn-exit'), 'CA');
});

test('a dead proxy is skipped and marked bad; the next one is used', async () => {
  const list = {
    updated: 'now', names: { US: 'United States' },
    proxies: [
      { proto: 'http', address: '127.0.0.1', port: proxies.deadPort, code: 'US', ms: 1 },
      { proto: 'http', address: '127.0.0.1', port: proxies.connectPort, code: 'US', ms: 50 },
      { proto: 'socks5', address: '127.0.0.1', port: proxies.socksPort, code: 'CA', ms: 20 },
      { proto: 'http', address: 'not-an-ip', port: 1, code: 'US', ms: 1 },
    ],
  };
  const exits = createRemoteExits({ url: 'x', fetchList: async () => new Response(JSON.stringify(list)) });
  const countries = await exits.countries();
  assert.deepEqual(countries.map((c) => [c.code, c.count]), [['CA', 1], ['US', 2]]);
  assert.equal(countries.find((c) => c.code === 'US').name, 'United States');
  const f = exitFetch({ baseFetch: () => { throw new Error('should not be used'); }, openSocket, exits });
  // Picks are lightly shuffled to spread load; within a few tries the dead one comes up first.
  for (let i = 0; i < 40 && (await exits.countries()).find((c) => c.code === 'US').count === 2; i++) {
    const r = await f(url('/len'), { method: 'GET', headers: new Headers() }, { exit: 'US' });
    assert.equal(await r.text(), 'fixed', 'every request succeeds, even when the dead proxy is tried first');
  }
  // The dead one is now skipped.
  assert.equal((await exits.countries()).find((c) => c.code === 'US').count, 1);
  await assert.rejects(f(url('/len'), {}, { exit: 'FR' }), /No working free server in FR/);
});

test('gateway: /__tervyn/exits lists countries and the exit cookie routes through them', async () => {
  const list = { names: {}, proxies: [{ proto: 'socks5', address: '127.0.0.1', port: proxies.socksPort, code: 'JP', ms: 5 }] };
  const exits = createRemoteExits({ url: 'x', fetchList: async () => new Response(JSON.stringify(list)) });
  const gw = createGateway({ platform: 'test', allowPrivate: true, exits, fetch: exitFetch({ baseFetch: (u, i) => fetch(u, i), openSocket, exits }) });
  const ping = await (await gw(new Request('https://gw.test/__tervyn/ping'))).json();
  assert.equal(ping.exits, true);
  const c = await (await gw(new Request('https://gw.test/__tervyn/exits'))).json();
  assert.equal(c.countries[0].code, 'JP');
  const go = await gw(new Request(`https://gw.test/go?url=${encodeURIComponent(url('/'))}&exit=jp`));
  assert.match(go.headers.get('set-cookie'), /tervyn_exit=JP/);
  const page = await gw(new Request(`https://gw.test/p/http/127.0.0.1:${sitePort}/`, { headers: { cookie: 'tervyn_exit=JP' } }));
  assert.equal(page.headers.get('x-tervyn-exit'), 'JP');
  const html = await page.text();
  assert.match(html, /%22x%22%3A%22JP%22/, 'the page knows its exit country');
  assert.match(html, new RegExp(`href="/p/http/127.0.0.1:${sitePort}/len"`));
  const fail = await gw(new Request(`https://gw.test/p/http/127.0.0.1:${sitePort}/`, { headers: { cookie: 'tervyn_exit=FR' } }));
  assert.equal(fail.status, 502);
  assert.match(await fail.text(), /Browse this site without a country/);
});
