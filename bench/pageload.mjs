// Full page loads in a real browser: direct vs each gateway (vs another proxy).
// Measures first byte, first contentful paint and load event, median of RUNS.
//   node bench/pageload.mjs https://gw1.example.com https://gw2.example.com
//   OTHER='https://other-proxy.example/browse?url={url}' RUNS=3 node bench/pageload.mjs https://gw1...
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const RUNS = Number(process.env.RUNS || 3);
const sites = readFileSync(new URL('./sites.txt', import.meta.url), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
let gateways = process.argv.slice(2);
if (!gateways.length) gateways = JSON.parse(readFileSync(new URL('../gateways.json', import.meta.url), 'utf8')).gateways || [];
const viaGateway = (gw, site) => `${gw}/p/${site.replace(/^(https?):\/\//, '$1/')}`;
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null; };

const browser = await chromium.launch();
const rows = [];
async function measure(label, site, url) {
  const res = { ttfb: [], fcp: [], load: [] };
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext(); // cold cache each run
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      const m = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0];
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        return { ttfb: n?.responseStart, load: n?.loadEventStart, fcp: fcp?.startTime };
      });
      for (const k of Object.keys(res)) res[k].push(m[k]);
    } catch { /* counted as missing */ }
    await ctx.close();
  }
  rows.push({ site: site.replace(/^https?:\/\//, '').slice(0, 40), route: label, ttfb: median(res.ttfb), fcp: median(res.fcp), load: median(res.load) });
}
for (const site of sites) {
  await measure('direct', site, site);
  for (const gw of gateways) await measure(new URL(gw).host, site, viaGateway(gw, site));
  if (process.env.OTHER) await measure('other proxy', site, process.env.OTHER.replace('{url}', encodeURIComponent(site)));
}
await browser.close();
console.table(rows);
