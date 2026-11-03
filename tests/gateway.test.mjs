// End-to-end: a local test site <- Node gateway <- test client, plus fake free
// proxies (HTTP CONNECT and SOCKS5) for the exit-country path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { createNodeGateway } from '../platforms/node/server.mjs';
import { createUpstream } from '../platforms/node/upstream.mjs';
import { attachWsEcho, wsRoundTrip } from './helpers/ws-echo.mjs';

let site, siteUrl, gw, gwUrl, exits, connectProxy, socksProxy;
const seen = { exitHits: 0 };

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers['x-via-exit']) seen.exitHits++;
    switch (u.pathname) {
      case '/':
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'", 'x-frame-options': 'DENY' });
        return res.end('<html><head><title>T</title></head><body><a href="/next">n</a><img src="/i.png"></body></html>');
      case '/latin':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body>caf'), Buffer.from([0xe9]), Buffer.from('</body></html>')]));
      case '/redirect':
        res.writeHead(302, { location: '/landing?x=1' });
        return res.end();
      case '/cookie':
        res.writeHead(200, { 'set-cookie': ['a=1; Path=/; Domain=127.0.0.1', 'b=2; Path=/sub'] });
        return res.end('ok');
      case '/echo':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(req.headers));
      case '/style.css':
        res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=600' });
        return res.end('body{background:url(/bg.png)}');
      case '/gz':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        return res.end(zlib.gzipSync('hello compressed'));
      case '/post': {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`${req.method}:${body}`); });
        return;
      }
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('nope');
    }
  });
  attachWsEcho(site);
  siteUrl = `http://127.0.0.1:${await listen(site)}`;

  // Fake free proxies: CONNECT and SOCKS5, both forwarding to the test site.
  const pipeTo = (client, host, port, first) => {
    const up = net.connect(port, host, () => { if (first) client.write(first); client.pipe(up).pipe(client); });
    up.on('error', () => client.destroy());
  };
  connectProxy = net.createServer((c) => {
    c.once('data', (d) => {
      const m = d.toString().match(/^CONNECT ([^:]+):(\d+)/);
      if (!m) return c.destroy();
      pipeTo(c, m[1], Number(m[2]), 'HTTP/1.1 200 Connection established\r\n\r\n');
    });
  });
  socksProxy = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (d) => {
        const len = d[4];
        const host = d.subarray(5, 5 + len).toString();
        const port = d.readUInt16BE(5 + len);
        pipeTo(c, host, port, Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
  });
  const cport = await listen(connectProxy);
  const sport = await listen(socksProxy);

  ({ server: gw, exits } = createNodeGateway({ ALLOW_PRIVATE: '1', EXITS: '1', CACHE_MB: '16', RATE_LIMIT: '0', GATEWAYS: 'https://a.example, https://b.example/' }));
  exits._set([
    { proto: 'http', address: '127.0.0.1', port: cport, code: 'DE', ms: 5, fails: 0 },
    { proto: 'socks5', address: '127.0.0.1', port: sport, code: 'JP', ms: 7, fails: 0 },
  ]);
  gwUrl = `http://127.0.0.1:${await listen(gw)}`;
});

after(() => { for (const s of [site, gw, connectProxy, socksProxy]) s?.close(); gw?.closeAllConnections?.(); });

const p = (path) => `${gwUrl}/p/http/${siteUrl.slice(7)}${path}`;

test('home page, ping and gateway list', async () => {
  const home = await fetch(gwUrl + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Tervyn/);
  const ping = await (await fetch(gwUrl + '/__tervyn/ping')).json();
  assert.equal(ping.ok, true);
  assert.equal(ping.platform, 'node');
  assert.equal(ping.exits, true);
  const list = await (await fetch(gwUrl + '/__tervyn/gateways')).json();
  assert.equal(list.gateways[0], gwUrl);
  for (const g of ['https://a.example', 'https://b.example']) assert.ok(list.gateways.includes(g), g);
  assert.equal(new Set(list.gateways).size, list.gateways.length, 'no duplicates');
  const sw = await fetch(gwUrl + '/sw.js');
  assert.match(sw.headers.get('content-type'), /javascript/);
});

test('/go turns typed input into a proxy URL', async () => {
  const r = await fetch(`${gwUrl}/go?url=${encodeURIComponent('example.com/a')}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/p/https/example.com/a');
});

test('HTML is rewritten, blocking headers removed, client injected', async () => {
  const r = await fetch(p('/'), { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), null);
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.match(r.headers.get('server-timing'), /upstream;dur=\d+/);
  const html = await r.text();
  assert.match(html, /<head><script src="\/__tervyn\/client.js" data-tervyn="/);
  assert.match(html, new RegExp(`href="/p/http/${siteUrl.slice(7)}/next"`));
  assert.match(html, new RegExp(`src="/p/http/${siteUrl.slice(7)}/i.png"`));
});

test('pages in other charsets are decoded correctly', async () => {
  const r = await fetch(p('/latin'));
  assert.match(r.headers.get('content-type'), /utf-8/);
  assert.match(await r.text(), /café/);
});

test('redirects stay on the gateway', async () => {
  const r = await fetch(p('/redirect'), { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/p/http/${siteUrl.slice(7)}/landing?x=1`);
});

test('cookies are scoped per site and internal cookies are not forwarded', async () => {
  const r = await fetch(p('/cookie'));
  const cookies = r.headers.getSetCookie();
  assert.deepEqual(cookies, [`a=1; Path=/p/http/${siteUrl.slice(7)}/`, `b=2; Path=/p/http/${siteUrl.slice(7)}/sub`]);
  const echo = await (await fetch(p('/echo'), { headers: { cookie: 'a=1; tervyn_exit=; __Host_s=2', 'x-forwarded-for': '1.2.3.4', referer: p('/page') } })).json();
  assert.equal(echo.cookie, 'a=1; __Host-s=2');
  assert.equal(echo['x-forwarded-for'], undefined);
  assert.equal(echo.referer, `${siteUrl}/page`);
  assert.equal(echo.host, siteUrl.slice(7));
});

test('compressed upstream bodies are decoded; POST bodies are forwarded', async () => {
  assert.equal(await (await fetch(p('/gz'))).text(), 'hello compressed');
  const r = await fetch(p('/post'), { method: 'POST', body: 'a=1&b=2', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(await r.text(), 'POST:a=1&b=2');
});

test('CSS is rewritten and cached', async () => {
  const a = await fetch(p('/style.css'));
  assert.equal(await a.text(), `body{background:url(/p/http/${siteUrl.slice(7)}/bg.png)}`);
  const b = await fetch(p('/style.css'));
  assert.equal(b.headers.get('x-tervyn-cache'), 'HIT');
  assert.equal(await b.text(), `body{background:url(/p/http/${siteUrl.slice(7)}/bg.png)}`);
});

test('root-relative requests that escaped rewriting are recovered from the Referer', async () => {
  const r = await fetch(`${gwUrl}/api/data?x=1`, { redirect: 'manual', headers: { referer: p('/page') } });
  assert.equal(r.status, 307);
  assert.equal(new URL(r.headers.get('location')).pathname + new URL(r.headers.get('location')).search, `/p/http/${siteUrl.slice(7)}/api/data?x=1`);
});

test('a site cannot install its own service worker', async () => {
  const r = await fetch(p('/sw.js'), { headers: { 'service-worker': 'script' } });
  assert.match(await r.text(), /disabled/);
});

test('exit countries go through free proxies (HTTP CONNECT and SOCKS5)', async () => {
  const countries = await (await fetch(gwUrl + '/__tervyn/exits')).json();
  assert.deepEqual(countries.countries.map((c) => c.code).sort(), ['DE', 'JP']);
  for (const code of ['DE', 'JP']) {
    const r = await fetch(p('/echo'), { headers: { cookie: `tervyn_exit=${code}`, 'x-via-exit': '1' } });
    assert.equal(r.headers.get('x-tervyn-exit'), code);
    assert.equal(r.status, 200);
  }
  assert.equal(seen.exitHits, 2);
  const none = await fetch(p('/echo'), { headers: { cookie: 'tervyn_exit=FR' } });
  assert.equal(none.status, 502);
});

test('private targets are refused unless allowed', async () => {
  const { server } = createNodeGateway({ CACHE_MB: '0' });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/p/http/127.0.0.1:${new URL(siteUrl).port}/`);
    assert.equal(r.status, 403);
    const r2 = await fetch(`http://127.0.0.1:${port}/p/http/169.254.169.254/latest/meta-data/`);
    assert.equal(r2.status, 403);
  } finally { server.close(); server.closeAllConnections(); }
  // A public-looking name that resolves to a private IP is caught at DNS time.
  const up = createUpstream({ allowPrivate: false });
  await assert.rejects(up(`http://localhost:${new URL(siteUrl).port}/`, { method: 'GET', headers: new Headers() }), /private network/);
});

test('WebSockets are bridged to the site', async () => {
  assert.equal(await wsRoundTrip(`${gwUrl.replace('http', 'ws')}/p/http/${siteUrl.slice(7)}/ws`, 'yo'), 'echo:yo');
});

test('own pages carry security headers; about page and favicon exist', async () => {
  const home = await fetch(gwUrl + '/');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(gwUrl + '/__tervyn/about')).status, 200);
  assert.equal((await fetch(gwUrl + '/favicon.ico')).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await (await fetch(gwUrl + '/__tervyn/health')).json()).ok, true);
});
