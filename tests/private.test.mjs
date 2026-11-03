// Your own proxies with logins (Webshare-style), as the only country servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { parsePrivateProxies, createPrivateExits } from '../platforms/node/private-exits.mjs';
import { createUpstream } from '../platforms/node/upstream.mjs';
import { fetchViaProxy } from '../gateway/tunnel.js';
import { createGateway } from '../gateway/core.js';
import { startFakeProxies } from './helpers/fake-proxies.mjs';

let site, sitePort, fake;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
before(async () => {
  site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head></head><body>hi ${req.url}</body></html>`); });
  sitePort = await listen(site);
  fake = await startFakeProxies();
});
after(() => { site.close(); fake.close(); });

test('reads every common proxy-list layout', () => {
  const list = parsePrivateProxies(`
203.0.113.7:6014:alice:secret1
203.0.113.7:6014:bob:secret2
user:pw:1.2.3.4:8080, user:pw@5.6.7.8:3128
socks5://a:b@9.9.9.9:1080  http://10.0.0.1:80/  1.1.1.1:3128  garbage  203.0.113.7:6014:alice:secret1`);
  assert.deepEqual(list.map((p) => `${p.proto} ${p.user}@${p.address}:${p.port}`), [
    'http alice@203.0.113.7:6014', 'http bob@203.0.113.7:6014', 'http user@1.2.3.4:8080',
    'http user@5.6.7.8:3128', 'socks5 a@9.9.9.9:1080', 'http @10.0.0.1:80', 'http @1.1.1.1:3128',
  ]);
  assert.equal(list[0].pass, 'secret1');
});

test('HTTP and SOCKS5 proxies with a login (Node upstream and the edge tunnel)', async () => {
  const exits = {
    pick: async () => [{ proto: 'http', address: '127.0.0.1', port: fake.authConnectPort, user: 'u', pass: 'p', code: 'US' }],
    ok() {}, fail() {},
  };
  const up = createUpstream({ allowPrivate: true, exits });
  const r = await up(`http://127.0.0.1:${sitePort}/a`, { method: 'GET', headers: new Headers() }, { exit: 'US' });
  assert.match(await r.text(), /hi \/a/);
  const socks = { ...exits, pick: async () => [{ proto: 'socks5', address: '127.0.0.1', port: fake.authSocksPort, user: 'u', pass: 'p', code: 'US' }] };
  const r2 = await createUpstream({ allowPrivate: true, exits: socks })(`http://127.0.0.1:${sitePort}/b`, { method: 'GET', headers: new Headers() }, { exit: 'US' });
  assert.match(await r2.text(), /hi \/b/);
  // Wrong password is refused.
  const bad = { ...exits, pick: async () => [{ proto: 'http', address: '127.0.0.1', port: fake.authConnectPort, user: 'u', pass: 'x', code: 'US' }] };
  await assert.rejects(createUpstream({ allowPrivate: true, exits: bad })(`http://127.0.0.1:${sitePort}/`, { method: 'GET', headers: new Headers() }, { exit: 'US' }), /407/);
  // The edge tunnel (Cloudflare/Deno code path) logs in too.
  const openSocket = async (h, port) => { const s = net.connect(port, h); await new Promise((ok) => s.once('connect', ok)); return { readable: Readable.toWeb(s), writable: Writable.toWeb(s), close: () => s.destroy() }; };
  for (const p of [{ proto: 'http', port: fake.authConnectPort }, { proto: 'socks5', port: fake.authSocksPort }]) {
    const res = await fetchViaProxy(openSocket, { ...p, address: '127.0.0.1', user: 'u', pass: 'p', code: 'US' }, `http://127.0.0.1:${sitePort}/c`);
    assert.match(await res.text(), /hi \/c/);
  }
});

test('only your proxies are offered; logins are never shown', async () => {
  const text = `127.0.0.1:${fake.authConnectPort}:u:p 127.0.0.1:${fake.authSocksPort}:u:p 127.0.0.1:${fake.deadPort}:u:p`;
  // Stand-in for the real HTTPS test: the first two are "US", the dead one fails.
  const exits = createPrivateExits({ text, test: async (p) => { if (p.port === fake.deadPort) throw new Error('down'); return { code: 'US', ms: 10 }; } });
  const gw = createGateway({ platform: 'test', allowPrivate: true, exits, fetch: createUpstream({ allowPrivate: true, exits }) });
  const list = await (await gw(new Request('https://gw.test/__tervyn/exits'))).text();
  assert.deepEqual(JSON.parse(list).countries.map((c) => [c.code, c.count]), [['US', 2]]);
  assert.doesNotMatch(list, /127\.0\.0\.1|"u"|"p"/, 'no addresses or logins leak');
  for (let i = 0; i < 4; i++) {
    const r = await gw(new Request(`https://gw.test/p/http/127.0.0.1:${sitePort}/x${i}`, { headers: { cookie: 'tervyn_exit=US' } }));
    assert.equal(r.headers.get('x-tervyn-exit'), 'US');
    assert.match(await r.text(), new RegExp(`hi /x${i}`));
  }
});
