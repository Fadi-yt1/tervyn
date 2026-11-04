// Tervyn Remote Browser: a real Chrome on this server, used from any web page.
// The page streams Chrome's screen (JPEG frames over a WebSocket) and sends back
// your mouse, keyboard and scrolling. Pick one of your Webshare servers and Chrome
// connects through it, so sites see a normal browser on that IP; human checks run
// in this real browser and you complete them yourself.
//
//   ACCESS_KEY=... PRIVATE_PROXIES="ip:port:user:pass ..." node browser/server.mjs
//
// Environment:
//   PORT             default 8090
//   ACCESS_KEY       required: the key you type on the page (keeps strangers out)
//   PRIVATE_PROXIES  your proxies (any layout: ip:port:user:pass, user:pass@ip:port, ...)
//   MAX_SESSIONS     open sessions at once (default: as many as the memory allows, ~350 MB each)
//   IDLE_MINUTES     close a session after this long without input (default 0 = never)
//   HEADLESS=1       run without a window (default: a normal Chrome window; on Linux servers
//                    that needs a display, e.g. Xvfb as in the Dockerfile)
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parsePrivateProxies } from '../platforms/node/private-exits.mjs';
import { normalizeInput, checkTarget, isPrivateAddress } from '../gateway/url.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');

export function createRemoteBrowser(env = process.env) {
  const accessKey = String(env.ACCESS_KEY || '');
  // Default: as many sessions as memory allows (keep ~600 MB for the system and Chrome itself).
  const autoMax = Math.max(1, Math.floor((os.totalmem() / 1048576 - 600) / 350));
  const maxSessions = Number(env.MAX_SESSIONS) > 0 ? Number(env.MAX_SESSIONS) : autoMax;
  const idleMs = Number(env.IDLE_MINUTES || 0) * 60000; // 0 = sessions stay open until you close the tab
  // Windows and macOS always have a screen; Linux only when DISPLAY is set (desktop or Xvfb).
  const hasScreen = process.platform === 'win32' || process.platform === 'darwin' || !!env.DISPLAY;
  const headless = env.HEADLESS === '1' || !hasScreen;
  const allowPrivate = env.ALLOW_PRIVATE === '1'; // tests only
  const app = readFileSync(new URL('./app.html', import.meta.url), 'utf8');

  // Your proxies grouped by address: "Server 1", "Server 2", ... Logins rotate per session.
  const servers = [];
  for (const p of parsePrivateProxies(env.PRIVATE_PROXIES || '')) {
    let s = servers.find((x) => x.address === p.address && x.port === p.port);
    if (!s) { s = { id: `P${servers.length + 1}`, address: p.address, port: p.port, logins: [], turn: 0 }; servers.push(s); }
    s.logins.push(p);
  }

  const keyOk = (k) => {
    if (!accessKey) return false;
    const a = Buffer.from(String(k || '')); const b = Buffer.from(accessKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // One Chrome for all sessions (each session is its own private context). Concurrent
  // starts share the same launch, so a second Chrome is never leaked.
  let browser = null;
  let launching = null;
  async function getBrowser() {
    if (browser?.isConnected()) return browser;
    launching ||= chromium.launch({
      headless,
      // "Direct" really means direct: never inherit a proxy from the server's environment.
      // Sessions on one of your servers set their own proxy per context.
      args: ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
        // No background traffic of Chrome's own (updates, Google services): saves proxy data.
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--no-pings',
        // On your own computer, keep the server's Chrome windows minimized.
        ...(process.platform === 'win32' || process.platform === 'darwin' ? ['--start-minimized'] : [])],
    }).then((b) => { browser = b; return b; }).finally(() => { launching = null; });
    return launching;
  }

  const sessions = new Set();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(body); };
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return send(200, 'text/html; charset=utf-8', app, {
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
        'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      });
    }
    if (u.pathname === '/health') return send(200, 'application/json', JSON.stringify({ ok: true, sessions: sessions.size }));
    if (u.pathname === '/api/servers') {
      if (!keyOk(u.searchParams.get('key'))) return send(401, 'application/json', JSON.stringify({ error: 'wrong access key' }));
      // Addresses only, never logins.
      return send(200, 'application/json', JSON.stringify({ servers: servers.map((s) => ({ id: s.id, address: s.address, logins: s.logins.length })), busy: sessions.size >= maxSessions }));
    }
    send(404, 'text/plain', 'not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws' || !keyOk(u.searchParams.get('key'))) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => startSession(ws, u.searchParams).catch((e) => {
      try { ws.send(JSON.stringify({ t: 'error', msg: String(e.message || e).slice(0, 200) })); ws.close(); } catch { /* closed */ }
    }));
  });

  async function startSession(ws, params) {
    if (sessions.size >= maxSessions) { ws.send(JSON.stringify({ t: 'error', msg: 'All browsers are in use. Try again in a few minutes.' })); ws.close(); return; }
    const w = Math.max(320, Math.min(1920, Number(params.get('w')) || 1280));
    const h = Math.max(320, Math.min(1200, Number(params.get('h')) || 800));
    const chosen = servers.find((s) => s.id === params.get('server'));
    let proxy;
    if (chosen) {
      const login = chosen.logins[chosen.turn++ % chosen.logins.length];
      // Chrome supports logins on HTTP proxies (Webshare's default); SOCKS5 logins are not supported by Chrome.
      proxy = { server: `http://${chosen.address}:${chosen.port}`, username: login.user, password: login.pass };
    }
    const session = { ws, closed: false };
    sessions.add(session);
    const b = await getBrowser();
    const context = await b.newContext({ viewport: { width: w, height: h }, proxy, acceptDownloads: false });
    session.context = context;

    // Without a proxy, Chrome runs on this server's network: keep it off private addresses.
    if (!proxy && !allowPrivate) {
      await context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname.replace(/^\[|\]$/g, ''); } catch { /* data: etc. */ }
        const literal = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
        if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host) || (literal && isPrivateAddress(host))) return route.abort('blockedbyclient');
        return route.continue();
      });
    }

    let page = null;
    let cdp = null;
    let size = { w, h };
    const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const state = async () => {
      if (!page || page.isClosed()) return;
      let title = '';
      try { title = await page.title(); } catch { /* navigating */ }
      sendJson({ t: 'state', url: page.url(), title, server: chosen ? chosen.id : '' });
    };

    async function watch(p) {
      if (cdp) { try { await cdp.send('Page.stopScreencast'); await cdp.detach(); } catch { /* gone */ } }
      page = p;
      cdp = await context.newCDPSession(p);
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        // Skip frames while the connection is backed up, so input stays snappy.
        if (ws.readyState === 1 && ws.bufferedAmount < 3e6) ws.send(Buffer.from(data, 'base64'));
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: size.w, maxHeight: size.h, everyNthFrame: 1 });
      p.on('framenavigated', (f) => { if (f === p.mainFrame()) state(); });
      p.on('load', state);
      p.on('close', async () => {
        if (session.closed || p !== page) return;
        try {
          const rest = context.pages().filter((x) => !x.isClosed());
          await watch(rest.length ? rest[rest.length - 1] : await context.newPage());
          state();
        } catch { /* the session is shutting down */ }
      });
      state();
    }
    // Pop-ups and new tabs: follow the newest one.
    context.on('page', (p) => { if (p !== page) watch(p).catch(() => {}); });
    await watch(await context.newPage());

    let idle;
    const touch = () => {
      clearTimeout(idle);
      if (!idleMs) return;
      idle = setTimeout(() => { sendJson({ t: 'error', msg: 'Closed after being idle. Reconnect to start again.' }); end(); }, idleMs);
      idle.unref?.();
    };
    session.end = end;
    async function end() {
      if (session.closed) return;
      session.closed = true;
      clearTimeout(idle);
      sessions.delete(session);
      try { await context.close(); } catch { /* gone */ }
      try { ws.close(); } catch { /* gone */ }
    }
    touch();
    ws.on('close', end);
    ws.on('error', end);

    ws.on('message', async (raw) => {
      touch();
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      try {
        const mouse = page.mouse;
        switch (m.t) {
          case 'move': await mouse.move(m.x, m.y); break;
          case 'down': await mouse.move(m.x, m.y); await mouse.down({ button: m.button || 'left', clickCount: m.clicks || 1 }); break;
          case 'up': await mouse.move(m.x, m.y); await mouse.up({ button: m.button || 'left', clickCount: m.clicks || 1 }); break;
          case 'wheel': await mouse.move(m.x, m.y); await mouse.wheel(m.dx || 0, m.dy || 0); break;
          case 'keydown': await page.keyboard.down(m.key); break;
          case 'keyup': await page.keyboard.up(m.key); break;
          case 'text': if (typeof m.text === 'string') await page.keyboard.insertText(m.text.slice(0, 5000)); break;
          case 'go': {
            const target = normalizeInput(m.url);
            if (!target) break;
            const blocked = !proxy && !allowPrivate ? checkTarget(target) : '';
            if (blocked) { sendJson({ t: 'notice', msg: blocked }); break; }
            await page.goto(target.href, { waitUntil: 'commit', timeout: 45000 });
            break;
          }
          case 'back': await page.goBack({ waitUntil: 'commit' }).catch(() => {}); break;
          case 'forward': await page.goForward({ waitUntil: 'commit' }).catch(() => {}); break;
          case 'reload': await page.reload({ waitUntil: 'commit' }).catch(() => {}); break;
          case 'resize': {
            size = { w: Math.max(320, Math.min(1920, m.w | 0)), h: Math.max(320, Math.min(1200, m.h | 0)) };
            await page.setViewportSize({ width: size.w, height: size.h });
            await cdp.send('Page.stopScreencast').catch(() => {});
            await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: size.w, maxHeight: size.h, everyNthFrame: 1 });
            break;
          }
          default: break;
        }
      } catch (e) {
        if (m.t === 'go') sendJson({ t: 'notice', msg: `Couldn't open that page: ${String(e.message || e).split('\n')[0].slice(0, 160)}` });
      }
    });
    sendJson({ t: 'ready', w, h, server: chosen ? chosen.id : '' });
  }

  return {
    server,
    close: async () => {
      for (const s of [...sessions]) { try { await s.end?.(); } catch { /* gone */ } }
      for (const c of wss.clients) c.terminate();
      await (launching || Promise.resolve()).catch(() => {});
      await browser?.close().catch(() => {});
      server.close(); server.closeAllConnections?.();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.ACCESS_KEY) { console.error('Set ACCESS_KEY (the key you will type on the page).'); process.exit(1); }
  const remote = createRemoteBrowser();
  const { server } = remote;
  const port = Number(process.env.PORT || 8090);
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Tervyn remote browser on http://localhost:${port}`));
  // Close Chrome cleanly on Ctrl+C / stop.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { remote.close().finally(() => process.exit(0)); });
}
