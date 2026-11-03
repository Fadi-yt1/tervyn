// Builds proxies.json: real, working free proxies grouped by country.
// Downloads every public free proxy list, then tests each server: it must open
// an HTTPS connection to www.cloudflare.com with a valid certificate (so it
// works for secure sites and can't tamper with them) and return a real page.
// The page also tells us the server's real country.
//
//   node scripts/validate-proxies.mjs out/proxies.json [previous-list-url]
//
// Runs every 30 minutes in .github/workflows/proxies.yml (free on GitHub Actions).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FREE_SOURCES, parseList, testProxy, countryName } from '../platforms/node/exits.mjs';

const GH = 'https://raw.githubusercontent.com/';
// More public lists on top of the ones the VPN extension uses.
const EXTRA_SOURCES = [
  { name: 'TheSpeedX HTTP', proto: 'http', weight: 1, url: GH + 'TheSpeedX/PROXY-List/master/http.txt' },
  { name: 'clarketm', proto: 'http', weight: 1, url: GH + 'clarketm/proxy-list/master/proxy-list-raw.txt' },
  { name: 'mmpx12 HTTPS', proto: 'http', weight: 2, url: GH + 'mmpx12/proxy-list/master/https.txt' },
  { name: 'mmpx12 SOCKS5', proto: 'socks5', weight: 2, url: GH + 'mmpx12/proxy-list/master/socks5.txt' },
  { name: 'hookzof SOCKS5', proto: 'socks5', weight: 2, url: GH + 'hookzof/socks5_list/master/proxy.txt' },
  { name: 'ErcinDedeoglu HTTPS', proto: 'http', weight: 2, url: GH + 'ErcinDedeoglu/proxies/main/proxies/https.txt' },
  { name: 'ErcinDedeoglu SOCKS5', proto: 'socks5', weight: 2, url: GH + 'ErcinDedeoglu/proxies/main/proxies/socks5.txt' },
  { name: 'KangProxy HTTPS', proto: 'http', weight: 2, url: GH + 'officialputuid/KangProxy/KangProxy/https/https.txt' },
  { name: 'Proxifly HTTP', proto: 'http', weight: 1, url: GH + 'proxifly/free-proxy-list/main/proxies/protocols/http/data.txt' },
  { name: 'ProxyScrape SOCKS5', proto: 'socks5', weight: 2, url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text' },
  { name: 'Geonode SOCKS5', proto: 'socks5', weight: 2, json: true, url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5' },
];
const SOURCES = [...FREE_SOURCES, ...EXTRA_SOURCES];

const TEST_MAX = Number(process.env.TEST_MAX || 6000);   // candidates to test
const CONCURRENCY = Number(process.env.CONCURRENCY || 300);
const PER_COUNTRY = Number(process.env.PER_COUNTRY || 40);
const out = process.argv[2] || 'out/proxies.json';
const previousUrl = process.argv[3] || '';

const keyOf = (p) => `${p.proto}://${p.address}:${p.port}`;

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; try { await fn(item); } catch { /* dead */ } }
  }));
}

const started = Date.now();
const results = await Promise.allSettled(SOURCES.map(async (src) => {
  const res = await fetch(src.url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { src, list: parseList(await res.text(), src.proto, src.json) };
}));
const byKey = new Map();
let sourcesOk = 0;
for (const r of results) {
  if (r.status !== 'fulfilled') continue;
  if (r.value.list.length) sourcesOk++;
  for (const p of r.value.list) {
    const prev = byKey.get(keyOf(p));
    if (prev) prev.score += r.value.src.weight; else byKey.set(keyOf(p), { ...p, score: r.value.src.weight });
  }
}
// Servers that worked last time go first: they're the likeliest to still work.
if (previousUrl) {
  try {
    const prev = await (await fetch(previousUrl, { signal: AbortSignal.timeout(20000) })).json();
    for (const p of prev.proxies || []) {
      const k = keyOf(p);
      byKey.set(k, { ...(byKey.get(k) || p), score: (byKey.get(k)?.score || 0) + 100 });
    }
  } catch { /* first run */ }
}
const candidates = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, TEST_MAX);
console.log(`${byKey.size} unique servers from ${sourcesOk}/${SOURCES.length} lists; testing ${candidates.length}`);

const working = [];
await mapLimit(candidates, CONCURRENCY, async (p) => {
  const r = await testProxy(p, 8000);
  // A second, quick check weeds out servers that only work once.
  const r2 = await testProxy(p, 8000);
  if (r.code !== r2.code) return;
  working.push({ proto: p.proto, address: p.address, port: p.port, code: r.code, ms: Math.round((r.ms + r2.ms) / 2) });
});

// Keep the fastest PER_COUNTRY in each country.
const byCountry = new Map();
for (const p of working.sort((a, b) => a.ms - b.ms)) {
  const list = byCountry.get(p.code) || [];
  if (list.length < PER_COUNTRY) list.push(p);
  byCountry.set(p.code, list);
}
const proxies = [...byCountry.values()].flat();
const names = Object.fromEntries([...byCountry.keys()].map((c) => [c, countryName(c)]));
const data = { updated: new Date().toISOString(), tested: candidates.length, sources: sourcesOk, names, proxies };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
const summary = [...byCountry.entries()].sort((a, b) => b[1].length - a[1].length).map(([c, l]) => `${c}:${l.length}`).join(' ');
console.log(`${working.length} working, ${proxies.length} kept in ${byCountry.size} countries in ${Math.round((Date.now() - started) / 1000)} s`);
console.log(summary);
