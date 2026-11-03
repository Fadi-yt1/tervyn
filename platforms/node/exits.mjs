// Free "exit country" servers for the Node gateway: the same 18 public proxy
// lists the Tervyn VPN extension uses. Every candidate must load a Cloudflare
// page over HTTPS with a valid certificate before it is used, which also tells
// us its real country. Working servers are re-checked every few minutes.
import tls from 'node:tls';
import { openTunnel } from './upstream.mjs';

const GH = 'https://raw.githubusercontent.com/';
export const FREE_SOURCES = [
  { name: 'jetkai (online)', proto: 'socks5', weight: 3, url: GH + 'jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt' },
  { name: 'jetkai HTTP (online)', proto: 'http', weight: 2, url: GH + 'jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt' },
  { name: 'monosans', proto: 'socks5', weight: 3, url: GH + 'monosans/proxy-list/main/proxies/socks5.txt' },
  { name: 'monosans HTTP', proto: 'http', weight: 2, url: GH + 'monosans/proxy-list/main/proxies/http.txt' },
  { name: 'elliottophellia (checked)', proto: 'socks5', weight: 3, url: GH + 'elliottophellia/proxylist/master/results/socks5/global/socks5_checked.txt' },
  { name: 'roosterkid', proto: 'socks5', weight: 3, url: GH + 'roosterkid/openproxylist/main/SOCKS5_RAW.txt' },
  { name: 'roosterkid HTTPS', proto: 'http', weight: 3, url: GH + 'roosterkid/openproxylist/main/HTTPS_RAW.txt' },
  { name: 'vakhov', proto: 'socks5', weight: 3, url: GH + 'vakhov/fresh-proxy-list/master/socks5.txt' },
  { name: 'vakhov HTTPS', proto: 'http', weight: 3, url: GH + 'vakhov/fresh-proxy-list/master/https.txt' },
  { name: 'prxchk', proto: 'socks5', weight: 3, url: GH + 'prxchk/proxy-list/main/socks5.txt' },
  { name: 'sunny9577', proto: 'socks5', weight: 2, url: GH + 'sunny9577/proxy-scraper/master/generated/socks5_proxies.txt' },
  { name: 'hideip.me', proto: 'socks5', weight: 2, url: GH + 'zloi-user/hideip.me/main/socks5.txt' },
  { name: 'Zaeem20', proto: 'socks5', weight: 2, url: GH + 'Zaeem20/FREE_PROXIES_LIST/master/socks5.txt' },
  { name: 'TheSpeedX', proto: 'socks5', weight: 1, url: GH + 'TheSpeedX/PROXY-List/master/socks5.txt' },
  { name: 'Proxifly HTTPS', proto: 'http', weight: 2, url: GH + 'proxifly/free-proxy-list/main/proxies/protocols/https/data.txt' },
  { name: 'Proxifly SOCKS5', proto: 'socks5', weight: 1, url: GH + 'proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt' },
  { name: 'ProxyScrape', proto: 'http', weight: 2, url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text' },
  { name: 'Geonode', proto: 'http', weight: 2, json: true, url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc' },
];

const MAX_PER_SOURCE = 3000;
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
export const countryName = (code) => { try { return regionNames?.of(code) || code; } catch { return code; } };

function normProto(p) {
  p = String(p || '').toLowerCase();
  if (p === 'socks5' || p === 'socks5h' || p === 'socks') return 'socks5';
  if (p === 'http' || p === 'https') return 'http';
  return null;
}

// Parses one list (text, or Geonode-style JSON) into { proto, address, port }.
export function parseList(text, defaultProto, isJson = false) {
  const out = [];
  if (isJson) {
    try {
      const data = JSON.parse(text);
      for (const row of data.data || data.proxies || []) {
        for (const p of [].concat(row.protocols || row.protocol || [])) {
          const proto = normProto(p);
          if (proto && /^\d+\.\d+\.\d+\.\d+$/.test(row.ip)) out.push({ proto, address: row.ip, port: Number(row.port) });
        }
      }
      return out;
    } catch { /* fall back to text */ }
  }
  const re = /(?:(https?|socks[45]h?):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/i;
  for (const line of text.split(/\r?\n/, MAX_PER_SOURCE)) {
    const m = line.match(re);
    if (!m) continue;
    const proto = normProto(m[1] || defaultProto);
    const port = Number(m[3]);
    if (proto && port > 0 && port < 65536) out.push({ proto, address: m[2], port });
  }
  return out;
}

// One check: TLS to www.cloudflare.com through the proxy, valid certificate, real page.
export async function testProxy(p, ms = 8000) {
  const t0 = Date.now();
  const raw = await openTunnel(p, 'www.cloudflare.com', 443, ms);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: raw, servername: 'www.cloudflare.com', ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, ms);
    let body = '';
    s.once('secureConnect', () => s.write('GET /cdn-cgi/trace HTTP/1.1\r\nHost: www.cloudflare.com\r\nConnection: close\r\n\r\n'));
    s.on('data', (d) => { body += d; if (body.length > 20000) s.destroy(); });
    s.once('error', (e) => { clearTimeout(timer); reject(e); });
    s.once('close', () => {
      clearTimeout(timer);
      const loc = body.match(/\nloc=([A-Z]{2})/);
      if (/^HTTP\/1\.[01] 200/.test(body) && loc) resolve({ ms: Date.now() - t0, code: loc[1] });
      else reject(new Error('bad answer'));
    });
  });
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; try { await fn(item); } catch { /* skip */ } }
  }));
}

export function createExitPool({ testCount = 800, keep = 300, concurrency = 64, log = console.log } = {}) {
  let working = [];            // { proto, address, port, code, ms, fails }
  let refreshing = null;

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const results = await Promise.allSettled(FREE_SOURCES.map(async (src) => {
        const res = await fetch(src.url, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { src, list: parseList(await res.text(), src.proto, src.json) };
      }));
      const byKey = new Map();
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const p of r.value.list) {
          const key = `${p.proto}://${p.address}:${p.port}`;
          const prev = byKey.get(key);
          if (prev) prev.score += r.value.src.weight; else byKey.set(key, { ...p, score: r.value.src.weight });
        }
      }
      const candidates = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, testCount);
      const found = [];
      await mapLimit(candidates, concurrency, async (p) => {
        const r = await testProxy(p);
        found.push({ proto: p.proto, address: p.address, port: p.port, code: r.code, ms: r.ms, fails: 0 });
      });
      const keyOf = (p) => `${p.proto}://${p.address}:${p.port}`;
      const merged = new Map(working.map((p) => [keyOf(p), p]));
      for (const p of found) merged.set(keyOf(p), p);
      working = [...merged.values()].filter((p) => p.fails < 2).sort((a, b) => a.ms - b.ms).slice(0, keep);
      log(`exits: ${byKey.size} candidates from ${results.filter((r) => r.status === 'fulfilled').length}/${FREE_SOURCES.length} lists, ${found.length} passed, ${working.length} kept in ${new Set(working.map((p) => p.code)).size} countries`);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function recheck() {
    const before = working.slice();
    await mapLimit(before, concurrency, async (p) => {
      try { const r = await testProxy(p); p.ms = Math.round((p.ms + r.ms) / 2); p.fails = 0; } catch { p.fails++; }
    });
    working = working.filter((p) => p.fails < 2).sort((a, b) => a.ms - b.ms);
  }

  return {
    refresh,
    recheck,
    start({ refreshMin = 30, recheckMin = 4 } = {}) {
      refresh().catch((e) => log('exits: refresh failed', e.message));
      setInterval(() => refresh().catch(() => {}), refreshMin * 60000).unref();
      setInterval(() => recheck().catch(() => {}), recheckMin * 60000).unref();
    },
    countries() {
      const by = new Map();
      for (const p of working) {
        const c = by.get(p.code) || { code: p.code, name: countryName(p.code), count: 0, ms: p.ms };
        c.count++; c.ms = Math.min(c.ms, p.ms);
        by.set(p.code, c);
      }
      return [...by.values()].sort((a, b) => b.count - a.count || a.ms - b.ms);
    },
    pick(code, n = 3) { return working.filter((p) => p.code === code && p.fails < 2).slice(0, n); },
    ok(p) { p.fails = 0; },
    fail(p) { p.fails++; if (p.fails >= 2) working = working.filter((x) => x !== p); },
    get size() { return working.length; },
    _set(list) { working = list; }, // tests
  };
}
