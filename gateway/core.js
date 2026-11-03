// Tervyn Gateway core: one web-standard (Request -> Response) handler shared by
// every platform adapter (Cloudflare Workers, Deno Deploy, Vercel Edge,
// Netlify Edge, Node). Adapters only pass in platform details.

import { PREFIX, decodeTarget, encodeTarget, normalizeInput, checkTarget } from './url.js';
import { rewriteHtml, rewriteCss, rewriteSetCookie, rewriteLocation, rewriteLinkHeader } from './rewrite.js';
import { ASSETS, GATEWAYS, BROWSER_URL } from './assets.js';

export const VERSION = '1.0.0';

// Request headers never sent to the target site (hop-by-hop, platform-internal, or would leak the user).
const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'forwarded', 'via', 'x-real-ip', 'true-client-ip', 'client-ip',
  'cdn-loop', 'service-worker', 'accept-encoding', 'origin', 'referer', 'cookie', 'priority',
]);
const DROP_REQUEST_PREFIX = ['cf-', 'x-forwarded-', 'x-vercel-', 'x-nf-', 'x-netlify-', 'x-deno-', 'fly-', 'x-amz-', 'sec-fetch-'];

// Response headers that would break pages served from the gateway's origin.
const DROP_RESPONSE = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'clear-site-data', 'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'alt-svc', 'public-key-pins', 'report-to', 'nel',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'set-cookie', 'referrer-policy',
  'permissions-policy', 'origin-agent-cluster', 'x-xss-protection',
]);

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const INTERNAL_COOKIE = /^tervyn_/;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...extra },
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Headers for the gateway's own pages (not proxied sites).
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src *; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

function errorPage(status, title, detail, target, extra = '') {
  const esc = escapeHtml;
  const retry = target ? `<p><a href="${esc(encodeTarget(target))}">Try again</a> · <a href="${esc(target.href)}" rel="noreferrer">Open directly (no proxy)</a></p>` : '';
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 16px;color:#1d2433;background:#f6f7fb}@media(prefers-color-scheme:dark){body{background:#11141b;color:#e6e9f0}a{color:#8ab4ff}}</style>` +
    `<h1>${esc(title)}</h1><p>${esc(detail)}</p>${retry}${extra}<p><a href="/">Tervyn home</a></p>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

// Spots sites showing a human check (Cloudflare challenge and similar).
function isBotCheck(res) {
  const h = res.headers;
  if ((h.get('cf-mitigated') || '').toLowerCase() === 'challenge') return true;
  if (res.status === 403 && /akamai|imperva|incapsula|datadome|perimeterx|kasada/i.test(`${h.get('server')} ${h.get('x-datadome') ? 'datadome' : ''} ${h.get('x-iinfo') ? 'incapsula' : ''}`)) return true;
  return false;
}

function stoppedPage(target, exit, e) {
  const extra = exit ? `<p><a href="/go?url=${encodeURIComponent(target.href)}&amp;exit=">Load it without a country</a> (free servers often drop out)</p>` : '';
  return errorPage(502, 'The page stopped loading', `The connection to ${target.host} dropped before the page finished (${String(e?.message || e).slice(0, 120)}). Try again.`, target, extra);
}

function getCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const v = headers.get('set-cookie');
  return v ? v.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

// Decodes HTML/CSS in its real charset (header, then <meta charset>), falling back to UTF-8.
// The result is sent back as UTF-8, and the HTTP header beats any <meta charset> in the page.
async function readText(res, type) {
  const buf = await res.arrayBuffer();
  let cs = (type.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 2048)));
    cs = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || head.match(/@charset\s+["']([\w-]+)/i) || [])[1];
  }
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

// ---------- simple per-isolate rate limiter (token bucket per client IP) ----------
function makeLimiter(perMinute) {
  const buckets = new Map();
  return (key) => {
    if (!perMinute || !key) return true;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: perMinute, at: now }; buckets.set(key, b); }
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
    b.at = now;
    if (buckets.size > 50000) buckets.clear();
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

function isCacheable(req, res, type) {
  if (req.method !== 'GET' || res.status !== 200) return false;
  if (req.headers.has('authorization') || req.headers.has('range')) return false;
  if (/text\/html/i.test(type) || res.headers.has('set-cookie') || res.headers.has('vary') && /cookie|\*/i.test(res.headers.get('vary'))) return false;
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  if (/no-store|private|no-cache/.test(cc)) return false;
  return /max-age=\d|s-maxage|immutable/.test(cc) || res.headers.has('expires');
}

/**
 * options:
 *   platform     'cloudflare' | 'deno' | 'vercel' | 'netlify' | 'node'
 *   fetch        upstream fetch(url, init, meta) — defaults to globalThis.fetch
 *   cache        optional { match(key), put(key, response) } for static assets
 *   gateways     list of other gateway URLs (the UI races them all)
 *   exits        optional { countries(): [{code,count,ms}] } (Node free-proxy exits)
 *   rateLimit    requests per minute per client IP (default 900)
 *   allowPrivate allow private/local targets (tests only)
 *   maxBody      largest request body accepted, in bytes (default 10 MB)
 *   info(req)    extra fields for /__tervyn/ping, e.g. { region: 'fra' }
 */
export function createGateway(options = {}) {
  const upstreamFetch = options.fetch || ((url, init) => fetch(url, init));
  const limiter = makeLimiter(options.rateLimit ?? 900);
  const maxBody = options.maxBody ?? 10 * 1024 * 1024;
  const gateways = [...GATEWAYS, ...(options.gateways || [])].map((g) => String(g).trim().replace(/\/+$/, '')).filter(Boolean);

  const timeoutMs = options.timeoutMs ?? 30000;

  return async function handle(request, ctx = {}) {
    let res;
    try {
      res = await route(request, ctx);
    } catch (e) {
      res = errorPage(500, 'Something went wrong', `The gateway hit an unexpected error (${String(e?.message || e).slice(0, 160)}). Please try again.`, null);
      try { console.error('tervyn: unexpected error', e?.stack || e); } catch { /* no console */ }
    }
    if (res.status === 101 || res.webSocket) return res; // WebSocket handshakes pass untouched
    const h = new Headers(res.headers);
    if (new URL(request.url).protocol === 'https:') h.set('strict-transport-security', 'max-age=31536000');
    if (!h.has('x-content-type-options')) h.set('x-content-type-options', 'nosniff');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  };

  async function route(request, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const clientIp = ctx.clientIp || '';

    // ----- gateway pages and APIs -----
    if (path === '/' || path === '/index.html' || path === '/__tervyn/home') {
      return new Response(ASSETS['index.html'], { headers: { ...PAGE_HEADERS, 'cache-control': 'no-cache' } });
    }
    if (path === '/__tervyn/about') {
      const contact = options.contact ? `<p>Report abuse or a problem: <a href="mailto:${escapeHtml(options.contact)}">${escapeHtml(options.contact)}</a></p>` : '';
      return new Response(ASSETS['about.html'].replace('<!--CONTACT-->', contact), { headers: { ...PAGE_HEADERS, 'cache-control': 'public, max-age=3600' } });
    }
    if (path === '/favicon.ico' || path === '/favicon.svg') {
      return new Response(ASSETS['favicon.svg'], { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
    }
    if (path === '/__tervyn/health') {
      return json({ ok: true });
    }
    if (path === '/sw.js') {
      return new Response(ASSETS['sw.js'], { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    if (path === '/__tervyn/client.js') {
      return new Response(ASSETS['client.js'], { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    }
    if (path === '/__tervyn/ping') {
      const extra = options.info ? await options.info(request, ctx) : {};
      return json({ ok: true, name: 'tervyn-gateway', version: VERSION, platform: options.platform || 'unknown', exits: !!(options.exits || options.exitsElsewhere), t: Date.now(), ...extra });
    }
    if (path === '/__tervyn/gateways') {
      return json({ self: url.origin, gateways: [...new Set([url.origin, ...gateways])], browser: options.browserUrl || BROWSER_URL || '' });
    }
    if (path === '/__tervyn/exits') {
      return json({
        countries: options.exits ? await options.exits.countries() : [],
        servers: options.exits?.servers ? await options.exits.servers() : [],
        source: options.exits?.source || 'public',
      });
    }
    if (path === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
    }
    if (path === '/go') {
      const target = normalizeInput(url.searchParams.get('url'));
      if (!target) return Response.redirect(new URL('/', url), 302);
      const headers = new Headers({ location: encodeTarget(target), 'cache-control': 'no-store' });
      if (url.searchParams.has('exit')) {
        const raw = (url.searchParams.get('exit') || '').toUpperCase();
        const exit = /^([A-Z]{2}|P\d{1,3})$/.test(raw) ? raw : '';
        headers.append('set-cookie', `tervyn_exit=${exit}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`);
      }
      return new Response(null, { status: 302, headers });
    }

    // ----- the proxy itself -----
    let target = decodeTarget(path, url.search);
    if (!target) {
      // A root-relative link the page built at runtime ("/api/x") escaped rewriting.
      // The Referer tells us which site it belongs to.
      const ref = request.headers.get('referer');
      let from = null;
      try { if (ref) { const r = new URL(ref); if (r.origin === url.origin) from = decodeTarget(r.pathname); } } catch { /* none */ }
      if (from) return Response.redirect(new URL(encodeTarget(new URL(path + url.search, from)), url), 307);
      return Response.redirect(new URL('/', url), 302);
    }

    const blocked = checkTarget(target, { allowPrivate: options.allowPrivate });
    if (blocked) return errorPage(403, 'This address is blocked', blocked, null);
    if (!limiter(clientIp)) return errorPage(429, 'Slow down', 'Too many requests from your network. Wait a minute and try again.', target);
    if (request.headers.get('service-worker') === 'script') {
      // A site's own service worker would take over our gateway origin.
      return new Response('// service workers are disabled behind Tervyn', { status: 200, headers: { 'content-type': 'text/javascript' } });
    }
    const len = Number(request.headers.get('content-length') || 0);
    if (len > maxBody) return errorPage(413, 'Upload too large', `Uploads through Tervyn are limited to ${Math.round(maxBody / 1048576)} MB.`, target);

    // Request headers for the target site.
    const headers = new Headers();
    for (const [k, v] of request.headers) {
      const key = k.toLowerCase();
      if (DROP_REQUEST.has(key) || DROP_REQUEST_PREFIX.some((p) => key.startsWith(p))) continue;
      headers.set(k, v);
    }
    headers.set('accept-encoding', 'gzip, deflate, br');
    const cookies = (request.headers.get('cookie') || '').split(';').map((c) => c.trim()).filter((c) => c && !INTERNAL_COOKIE.test(c));
    if (cookies.length) headers.set('cookie', cookies.map((c) => c.replace(/^__Host_/, '__Host-')).join('; '));
    const origin = request.headers.get('origin');
    if (origin) {
      // Same-origin requests from a proxied page carry the gateway's origin; translate it.
      let from = null;
      const ref = request.headers.get('referer');
      try { if (ref) from = decodeTarget(new URL(ref).pathname); } catch { /* none */ }
      headers.set('origin', (from || target).origin);
    }
    const ref = request.headers.get('referer');
    if (ref) {
      try {
        const r = new URL(ref);
        const real = r.origin === url.origin ? decodeTarget(r.pathname, r.search) : null;
        if (real) headers.set('referer', real.href);
      } catch { /* drop it */ }
    }

    const exitRaw = getCookie(request.headers.get('cookie'), 'tervyn_exit');
    const exit = /^([A-Z]{2}|P\d{1,3})$/.test(exitRaw) ? exitRaw : '';

    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      if (!options.websocket) return new Response('WebSockets are not supported on this gateway. Pick another gateway on the Tervyn home page.', { status: 501 });
      for (const k of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
        const v = request.headers.get(k);
        if (v) headers.set(k, v);
      }
      return options.websocket(request, target, headers, ctx);
    }
    const hasBody = !['GET', 'HEAD'].includes(request.method);

    // Static asset cache (shared by all users of this gateway node).
    const cacheKey = `https://cache.tervyn.invalid/${exit || '-'}/${target.href}`;
    const useCache = options.cache && request.method === 'GET' && !headers.has('authorization') && !headers.has('range');
    if (useCache) {
      try {
        const hit = await options.cache.match(cacheKey);
        if (hit) {
          const h = new Headers(hit.headers);
          h.set('x-tervyn-cache', 'HIT');
          return new Response(hit.body, { status: hit.status, headers: h });
        }
      } catch { /* cache miss */ }
    }

    const started = Date.now();
    let upstream;
    // Waits for the site's response headers (not the body, which may stream for long).
    const fetchOnce = async (withBody) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error('The site took too long to answer.')), timeoutMs);
      try {
        return await upstreamFetch(target.href, {
          method: request.method,
          headers,
          body: withBody ? request.body : undefined,
          redirect: 'manual',
          signal: abort.signal,
          ...(withBody ? { duplex: 'half' } : {}),
        }, { exit, clientIp });
      } catch (e) {
        if (abort.signal.aborted) throw new Error('The site took too long to answer.');
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      upstream = await fetchOnce(hasBody);
    } catch (e) {
      const msg = String(e?.message || e);
      const noExit = exit ? `<p><a href="/go?url=${encodeURIComponent(target.href)}&amp;exit=">Browse this site without a country</a> · <a href="/">Pick another country</a></p>` : '';
      return errorPage(502, exit ? (/^P\d+$/.test(exit) ? `Server ${exit.slice(1)} didn't connect` : `The ${exit} free servers didn't connect`) : "Couldn't reach this site",
        exit ? msg.slice(0, 300) : `The gateway could not connect to ${target.host}. ${msg.slice(0, 200)}`, target, noExit);
    }
    const upstreamMs = Date.now() - started;

    // Response headers back to the browser.
    const out = new Headers();
    for (const [k, v] of upstream.headers) {
      if (!DROP_RESPONSE.has(k.toLowerCase())) out.append(k, v);
    }
    for (const c of getSetCookies(upstream.headers)) out.append('set-cookie', rewriteSetCookie(c, target));
    const loc = upstream.headers.get('location');
    if (loc) out.set('location', rewriteLocation(loc, target));
    const link = upstream.headers.get('link');
    if (link) out.set('link', rewriteLinkHeader(link, target));
    const refresh = upstream.headers.get('refresh');
    if (refresh) out.set('refresh', refresh.replace(/(url\s*=\s*)(\S+)/i, (m, p, u) => p + rewriteLocation(u, target)));
    out.set('referrer-policy', 'same-origin');
    out.set('x-content-type-options', 'nosniff');
    out.set('server-timing', `upstream;dur=${upstreamMs}`);
    out.set('x-tervyn-gateway', options.platform || 'unknown');

    const status = upstream.status;
    if (NULL_BODY.has(status) || request.method === 'HEAD') {
      return new Response(null, { status, headers: out });
    }

    const type = upstream.headers.get('content-type') || '';
    const dest = request.headers.get('sec-fetch-dest') || '';
    const isPageLoad = (!dest || dest === 'document' || dest === 'iframe') && /text\/html/i.test(type) && request.method === 'GET';
    // Sites with a human check (e.g. Cloudflare) are shown as they are, so you can complete it.
    const botCheck = isPageLoad && isBotCheck(upstream);
    if (botCheck) out.set('x-tervyn-check', 'human');
    const isHtml = /text\/html|application\/xhtml/i.test(type) && dest !== 'script' && dest !== 'style';
    const isCss = /text\/css/i.test(type);

    if (isHtml) {
      const inject = `<script src="/__tervyn/client.js" data-tervyn="${encodeURIComponent(JSON.stringify({ u: target.href, p: options.label || options.platform || '', x: exit || '', ...(botCheck ? { h: 1 } : {}) }))}"></script>`;
      out.set('cache-control', 'no-cache, private');
      if (options.streamHtml && options.streamHtml.canStream(type)) {
        // Cloudflare: native streaming rewriter (low CPU, no buffering).
        out.set('content-type', type || 'text/html; charset=utf-8');
        out.set('x-tervyn-rewriter', 'stream');
        const streamed = options.streamHtml.transform(new Response(upstream.body, { status, headers: { 'content-type': type || 'text/html' } }), target.href, inject);
        return new Response(streamed.body, { status, headers: out });
      }
      let html;
      try {
        html = await readText(upstream, type);
      } catch (e) {
        // The connection dropped mid-page (common with free servers). Try once more.
        if (request.method !== 'GET') return stoppedPage(target, exit, e);
        try { html = await readText(await fetchOnce(false), type); } catch (e2) { return stoppedPage(target, exit, e2); }
      }
      out.set('content-type', 'text/html; charset=utf-8');
      out.set('x-tervyn-rewriter', 'buffer');
      return new Response(rewriteHtml(html, target.href, { inject }), { status, headers: out });
    }
    if (isCss) {
      let css;
      try { css = rewriteCss(await readText(upstream, type), target.href); } catch (e) {
        try { css = rewriteCss(await readText(await fetchOnce(false), type), target.href); } catch (e2) { return new Response('/* stylesheet failed to load */', { status: 502, headers: { 'content-type': 'text/css' } }); }
      }
      out.set('content-type', 'text/css; charset=utf-8');
      const res = new Response(css, { status, headers: out });
      if (useCache && isCacheable(request, upstream, type)) {
        try { await options.cache.put(cacheKey, res.clone()); } catch { /* best effort */ }
      }
      return res;
    }

    const res = new Response(upstream.body, { status, headers: out });
    if (useCache && isCacheable(request, upstream, type)) {
      const len2 = Number(upstream.headers.get('content-length') || 0);
      if (!len2 || len2 < 8 * 1024 * 1024) {
        try {
          const [a, b] = res.body.tee();
          const cached = new Response(b, { status, headers: out });
          const p = options.cache.put(cacheKey, cached).catch(() => {});
          if (ctx.waitUntil) ctx.waitUntil(p);
          return new Response(a, { status, headers: out });
        } catch { /* fall through */ }
      }
    }
    return res;
  }
}

export { PREFIX };
