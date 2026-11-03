// Your own proxies (e.g. Webshare) as the only exit servers. Set PRIVATE_PROXIES to the
// list, in any common layout, separated by spaces, commas or new lines:
//   ip:port:user:pass   user:pass:ip:port   user:pass@ip:port   http://user:pass@ip:port
//   socks5://user:pass@ip:port   ip:port
// Each one is tested (HTTPS to Cloudflare with a valid certificate), which also tells us its
// real country. Logins never leave the server: /__tervyn/exits lists countries and counts only.
import { testProxy, countryName } from './exits.mjs';

const IP = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function parsePrivateProxies(text, defaultProto = 'http') {
  const out = [];
  const seen = new Set();
  for (let tok of String(text || '').split(/[\s,;]+/)) {
    tok = tok.trim();
    if (!tok) continue;
    let proto = defaultProto;
    const m = tok.match(/^(https?|socks5h?):\/\//i);
    if (m) { proto = /^socks/i.test(m[1]) ? 'socks5' : 'http'; tok = tok.slice(m[0].length); }
    tok = tok.replace(/\/+$/, '');
    let address, port, user = '', pass = '';
    let at;
    if ((at = tok.lastIndexOf('@')) > 0) {
      [user, pass = ''] = tok.slice(0, at).split(':');
      [address, port] = tok.slice(at + 1).split(':');
    } else {
      const p = tok.split(':');
      if (p.length === 4 && IP.test(p[0])) [address, port, user, pass] = p;
      else if (p.length === 4 && IP.test(p[2])) [user, pass, address, port] = p;
      else if (p.length === 2) [address, port] = p;
      else continue;
    }
    port = Number(port);
    if (!IP.test(address || '') || !(port > 0 && port < 65536)) continue;
    const key = `${proto}://${user}:${pass}@${address}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ proto, address, port, user, pass });
  }
  return out;
}

export function createPrivateExits({ text, test = testProxy, recheckMs = 15 * 60 * 1000, log = () => {} }) {
  const all = parsePrivateProxies(text);
  let working = [];
  let checkedAt = 0;
  let checking = null;
  const cool = new Map();
  const key = (p) => `${p.proto}://${p.user}@${p.address}:${p.port}`;

  async function check() {
    checking ||= (async () => {
      const found = [];
      await Promise.all(all.map(async (p) => {
        try { const r = await test(p, 10000); found.push({ ...p, code: r.code, ms: r.ms }); } catch { /* down right now */ }
      }));
      if (found.length || !working.length) working = found;
      checkedAt = Date.now();
      log(`private proxies: ${found.length}/${all.length} working`);
    })().finally(() => { checking = null; });
    return checking;
  }
  async function ready() {
    if (!checkedAt) await check();
    else if (Date.now() - checkedAt > recheckMs) check(); // refresh in the background
  }
  const usable = (p) => (cool.get(key(p)) || 0) < Date.now();
  let turn = 0;

  return {
    source: 'private',
    size: all.length,
    async countries() {
      await ready();
      const by = new Map();
      for (const p of working) {
        const c = by.get(p.code) || { code: p.code, name: countryName(p.code), count: 0, ms: p.ms };
        c.count++; c.ms = Math.min(c.ms, p.ms);
        by.set(p.code, c);
      }
      return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    // Round-robin across your proxies (and accounts), skipping ones that just failed.
    async pick(code, n = 3) {
      await ready();
      const pool = working.filter((p) => p.code === code);
      const fresh = pool.filter(usable);
      const list = fresh.length ? fresh : pool;
      if (!list.length) return [];
      const start = turn++ % list.length;
      return [...list.slice(start), ...list.slice(0, start)].slice(0, n);
    },
    ok(p) { cool.delete(key(p)); },
    fail(p) { cool.set(key(p), Date.now() + 2 * 60 * 1000); },
  };
}
