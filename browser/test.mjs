// End-to-end: a test browser opens the remote-browser page, logs in with the access
// key, then drives the remote Chrome only through the streamed screen (clicks,
// typing, address bar), like a person would.   node browser/test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { createRemoteBrowser } from './server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const hits = [];
const site = http.createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><title>Remote test</title></head>
<body style="margin:0;font:20px sans-serif">
  <button id="b" style="position:absolute;left:40px;top:40px;width:200px;height:60px" onclick="fetch('/clicked')">Click me</button>
  <form action="/typed" style="position:absolute;left:40px;top:140px">
    <input name="q" style="width:300px;height:40px;font-size:20px">
  </form>
</body></html>`);
});
const sitePort = await listen(site);
// A login-required HTTP proxy (answers 407 with a Basic challenge, like Webshare).
const proxyLog = [];
const proxy = http.createServer((req, res) => {
  const auth = req.headers['proxy-authorization'] || '';
  if (auth !== 'Basic ' + Buffer.from('alice:secret').toString('base64')) {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' }); return res.end();
  }
  proxyLog.push(req.url);
  const u = new URL(req.url);
  const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
proxy.on('connect', (req, sock) => {
  const auth = req.headers['proxy-authorization'] || '';
  if (auth !== 'Basic ' + Buffer.from('alice:secret').toString('base64')) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n'); return; }
  const [h, p] = req.url.split(':'); const up = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(sock).pipe(up); });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
const proxyPort = await listen(proxy);
const remote = createRemoteBrowser({ ACCESS_KEY: 'test-key', HEADLESS: process.env.DISPLAY ? '' : '1', DISPLAY: process.env.DISPLAY || '', ALLOW_PRIVATE: '1', PRIVATE_PROXIES: `127.0.0.1:${proxyPort}:alice:wrong 127.0.0.1:${proxyPort}:alice:secret` });
const port = await listen(remote.server);
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out'); };

const browser = await chromium.launch();
try {
  // Server list never includes logins; a wrong key is refused.
  const list = await (await fetch(`http://127.0.0.1:${port}/api/servers?key=test-key`)).text();
  assert.match(list, /"P1"/); assert.doesNotMatch(list, /alice|secret|wrong/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/servers?key=nope`)).status, 401);

  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  if (process.env.DEBUG) page.on('websocket', (w) => { w.on('framereceived', (f) => typeof f.payload === 'string' && console.log('<<', f.payload.slice(0, 200))); w.on('framesent', (f) => console.log('>>', String(f.payload).slice(0, 120))); w.on('close', () => console.log('ws closed')); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#key', 'test-key');
  await page.selectOption('#server', '').catch(() => {});
  await page.click('#loginForm button');
  await page.waitForFunction(() => document.getElementById('login').hidden);
  // Direct mode for this test (the sample proxy doesn't exist).
  await page.selectOption('#server', '');
  await page.waitForFunction(() => /Direct/.test(document.getElementById('status').textContent), null, { timeout: 20000 });

  // Address bar -> remote Chrome opens the site.
  await page.fill('#url', `http://127.0.0.1:${sitePort}/`);
  await page.press('#url', 'Enter');
  await waitFor(() => hits.includes('/'));
  await page.waitForFunction(() => document.title.startsWith('Remote test'), null, { timeout: 15000 });

  // Click the button by clicking the picture of it (canvas maps 1:1 to the remote viewport).
  const c = await page.locator('#c').boundingBox();
  await page.waitForTimeout(800); // first frames
  await page.mouse.click(c.x + 140, c.y + 70);
  await waitFor(() => hits.includes('/clicked'));

  // Click into the text box, type, press Enter -> the form submits in the remote Chrome.
  await page.mouse.click(c.x + 150, c.y + 160);
  await page.keyboard.type('hello world');
  await page.keyboard.press('Enter');
  await waitFor(() => hits.some((h) => h.startsWith('/typed?q=hello+world')));

  // The screen actually shows pixels from the remote page.
  const painted = await page.evaluate(() => {
    const cv = document.getElementById('c'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let nonWhite = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) nonWhite++;
    return nonWhite;
  });
  assert.ok(painted > 0, 'frames are drawn');
  // Through your server (Webshare-style login). Logins rotate per session: the first has a
  // wrong password, so start a session, then a second one that uses the right login.
  const viaProxy = async () => {
    await page.selectOption('#server', 'P1');
    await page.waitForFunction(() => /Via server 1/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
    await page.fill('#url', `http://127.0.0.1:${sitePort}/via-proxy`);
    await page.press('#url', 'Enter');
  };
  await viaProxy();
  await page.waitForTimeout(1500);
  if (!proxyLog.some((u) => u.includes('/via-proxy'))) { await page.selectOption('#server', ''); await page.waitForTimeout(800); await viaProxy(); }
  await waitFor(() => proxyLog.some((u) => u.includes('/via-proxy')));
  assert.ok(hits.includes('/via-proxy'), 'the site was reached through the proxy');
  console.log('remote browser: all checks passed', hits, 'via proxy:', proxyLog);
} finally {
  await browser.close();
  await remote.close();
  site.close();
  proxy.close();
}

