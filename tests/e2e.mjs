// Real-browser test (Chromium via Playwright): service worker, toolbar, history and
// requests that page scripts build at runtime.   npm run e2e
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createNodeGateway } from '../platforms/node/server.mjs';
import { attachWsEcho } from './helpers/ws-echo.mjs';

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {
  console.log('e2e: playwright not installed, skipped'); process.exit(0);
}

const log = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let siteOrigin;
const site = http.createServer((req, res) => {
  // Requests through the gateway lack the browser's Sec-Fetch-* headers.
  log.push({ path: req.url, direct: !!req.headers['sec-fetch-mode'] });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/mod.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end('window.modLoaded = true; export default 1;');
  }
  if (u.pathname === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><title>Test site</title></head><body><h1>Hello</h1><div id="out">…</div>
<script>
  fetch('/api/data').then(r => r.json()).then(d => { document.getElementById('out').textContent = d.ok ? 'fetch-ok' : 'bad'; });
  window.tryImport = () => import('${'${ORIGIN}'}/mod.js').then(() => window.modLoaded === true);
</script></body></html>`.replace('${ORIGIN}', siteOrigin));
});
attachWsEcho(site);
siteOrigin = `http://127.0.0.1:${await listen(site)}`;
const { server: gw } = createNodeGateway({ ALLOW_PRIVATE: '1', RATE_LIMIT: '0', CACHE_MB: '0' });
const gwOrigin = `http://127.0.0.1:${await listen(gw)}`;
const page1 = `${gwOrigin}/p/http/${siteOrigin.slice(7)}/`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(page1);
  await page.waitForFunction(() => document.getElementById('out').textContent !== '…');
  assert.equal(await page.textContent('#out'), 'fetch-ok', 'root-relative fetch works on first load');
  assert.equal(await page.locator('tervyn-bar').count(), 1, 'toolbar is shown');

  // Wait for the service worker to take control, then reload so it handles everything.
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  // A cross-origin module import isn't patched by client.js: only the service worker can catch it.
  assert.equal(await page.evaluate(() => window.tryImport()), true, 'cross-origin import loads');
  const mod = log.filter((l) => l.path === '/mod.js');
  assert.ok(mod.length && mod.every((l) => !l.direct), 'module was fetched through the gateway, not directly');

  // pushState with a site path keeps the address on the gateway.
  const path = await page.evaluate(() => { history.pushState({}, '', '/deeper/page?q=1'); return location.pathname + location.search; });
  assert.equal(path, `/p/http/${siteOrigin.slice(7)}/deeper/page?q=1`);

  // Page code that builds a WebSocket URL from location.host still reaches the site.
  const wsReply = await page.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = () => ws.send('page');
    ws.onmessage = (e) => resolve(e.data);
    ws.onerror = () => resolve('error');
  }));
  assert.equal(wsReply, 'echo:page', 'WebSocket from page code goes through the gateway');

  // Sites can't replace our service worker.
  const blocked = await page.evaluate(() => navigator.serviceWorker.register('/evil-sw.js').then(() => false, () => true));
  assert.equal(blocked, true, 'site service worker registration is refused');

  assert.ok(log.every((l) => !l.direct), `no request reached the site directly: ${JSON.stringify(log.filter((l) => l.direct))}`);

  // Home page renders and lists this gateway.
  await page.goto(gwOrigin + '/');
  if (process.env.DEBUG) console.log(page.url(), (await page.content()).slice(0, 300));
  await page.waitForFunction(() => /Using /.test(document.getElementById('status').textContent));
  const gwStatus = await page.textContent('#status');

  // Static portal (what GitHub Pages serves): finds the gateway and sends the user through it.
  const root = new URL('..', import.meta.url);
  const portal = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '') || 'index.html';
    if (name === 'gateways.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ gateways: ['http://127.0.0.1:1', gwOrigin] })); }
    try { res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html' : 'image/svg+xml' }); res.end(readFileSync(new URL(name, root))); } catch { res.writeHead(404); res.end(); }
  });
  const portalOrigin = `http://127.0.0.1:${await listen(portal)}`;
  try {
    const p2 = await browser.newPage();
    await p2.goto(portalOrigin + '/');
    await p2.waitForFunction(() => /Using /.test(document.getElementById('status').textContent), null, { timeout: 15000 });
    assert.equal(await p2.getAttribute('a[href="about.html"]', 'href'), 'about.html');
    await p2.fill('#url', siteOrigin + '/');
    await p2.click('#goBtn');
    await p2.waitForURL(new RegExp(`^${gwOrigin}/p/http/`));
    assert.equal(await p2.textContent('h1'), 'Hello', 'portal sends the user through the gateway');
  } finally { portal.close(); }

  console.log('e2e: all checks passed —', gwStatus);
} finally {
  await browser.close();
  site.close(); gw.close(); gw.closeAllConnections();
}
