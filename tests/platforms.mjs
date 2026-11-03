// Runs the same checks against the Deno and Cloudflare (workerd via `wrangler dev`) adapters.
//   DENO_BIN=/path/to/deno WRANGLER_BIN=/path/to/wrangler node tests/platforms.mjs
// A runtime whose binary isn't given is skipped.
import http from 'node:http';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/redirect') { res.writeHead(302, { location: '/landing' }); return res.end(); }
  if (u.pathname === '/cookie') { res.writeHead(200, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/; HttpOnly'] }); return res.end('ok'); }
  if (u.pathname === '/gz') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('hello compressed')); }
  if (u.pathname === '/post') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => res.end(`${req.method}:${b}`)); return; }
  res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" });
  res.end('<html><head><title>T</title></head><body><a href="/next">n</a></body></html>');
});
const sitePort = await listen(site);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(base) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/__tervyn/ping'); if (r.ok) return r.json(); } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error(`${base} did not start`);
}

async function check(name, base) {
  const ping = await waitUp(base);
  assert.equal(ping.platform, name);
  const p = (path) => `${base}/p/http/127.0.0.1:${sitePort}${path}`;
  const home = await fetch(p('/'));
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-security-policy'), null);
  const html = await home.text();
  assert.match(html, /<head><script src="\/__tervyn\/client.js"/);
  assert.match(html, new RegExp(`href="/p/http/127.0.0.1:${sitePort}/next"`));
  const red = await fetch(p('/redirect'), { redirect: 'manual' });
  assert.equal(red.status, 302);
  assert.equal(red.headers.get('location'), `/p/http/127.0.0.1:${sitePort}/landing`);
  const ck = await fetch(p('/cookie'));
  assert.deepEqual(ck.headers.getSetCookie(), [`a=1; Path=/p/http/127.0.0.1:${sitePort}/`, `b=2; HttpOnly; Path=/p/http/127.0.0.1:${sitePort}/`]);
  assert.equal(await (await fetch(p('/gz'))).text(), 'hello compressed');
  assert.equal(await (await fetch(p('/post'), { method: 'POST', body: 'x=1' })).text(), 'POST:x=1');
  console.log(`platforms: ${name} passed`);
}

const runs = [];
if (process.env.DENO_BIN) {
  runs.push(['deno', 8791, () => spawn(process.env.DENO_BIN, ['run', '--allow-net', '--allow-env', 'platforms/deno/main.js'],
    { env: { ...process.env, PORT: '8791', ALLOW_PRIVATE: '1' }, stdio: 'ignore' })]);
}
if (process.env.WRANGLER_BIN) {
  runs.push(['cloudflare', 8792, () => spawn(process.env.WRANGLER_BIN, ['dev', '--port', '8792', '--ip', '127.0.0.1', '--var', 'ALLOW_PRIVATE:1', '--show-interactive-dev-session=false'],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: process.env.DEBUG ? 'inherit' : 'ignore' })]);
}
if (!runs.length) console.log('platforms: no runtimes given (set DENO_BIN and/or WRANGLER_BIN), skipped');
let failed = false;
for (const [name, port, start] of runs) {
  const child = start();
  try { await check(name, `http://127.0.0.1:${port}`); } catch (e) { failed = true; console.error(`platforms: ${name} FAILED:`, e.message); } finally { child.kill(); }
}
site.close();
process.exit(failed ? 1 : 0);
