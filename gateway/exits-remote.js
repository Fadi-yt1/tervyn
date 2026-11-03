// Exit countries from the published, pre-tested free proxy list (proxies.json,
// made every 30 minutes by .github/workflows/proxies.yml). Any gateway that can
// open TCP sockets uses this; nothing is tested at request time.

const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const nameOf = (code, names) => names?.[code] || (() => { try { return regionNames?.of(code) || code; } catch { return code; } })();

export function createRemoteExits({ url, fetchList = (u) => fetch(u), ttlMs = 5 * 60 * 1000 }) {
  let list = [];
  let names = {};
  let updated = '';
  let loadedAt = 0;
  let loading = null;
  const bad = new Map(); // "proto://ip:port" -> retry after (ms)
  const key = (p) => `${p.proto}://${p.address}:${p.port}`;

  async function load() {
    if (list.length && Date.now() - loadedAt < ttlMs) return;
    loading ||= (async () => {
      try {
        const res = await fetchList(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const next = (data.proxies || []).filter((p) =>
          (p.proto === 'http' || p.proto === 'socks5') && /^\d+\.\d+\.\d+\.\d+$/.test(p.address) && p.port > 0 && p.port < 65536 && /^[A-Z]{2}$/.test(p.code));
        if (next.length) { list = next; names = data.names || {}; updated = data.updated || ''; }
        loadedAt = Date.now();
      } catch {
        loadedAt = Date.now() - ttlMs + 30000; // retry in 30 s, keep the old list
      } finally { loading = null; }
    })();
    await loading;
  }

  const usable = (p) => (bad.get(key(p)) || 0) < Date.now();

  return {
    async countries() {
      await load();
      const by = new Map();
      for (const p of list) {
        if (!usable(p)) continue;
        const c = by.get(p.code) || { code: p.code, name: nameOf(p.code, names), count: 0, ms: p.ms || 0 };
        c.count++; c.ms = Math.min(c.ms || Infinity, p.ms || Infinity);
        by.set(p.code, c);
      }
      return [...by.values()].map((c) => ({ ...c, ms: Number.isFinite(c.ms) ? Math.round(c.ms) : 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    // The fastest few, lightly shuffled so users spread across servers.
    async pick(code, n = 3) {
      await load();
      const pool = list.filter((p) => p.code === code && usable(p)).sort((a, b) => (a.ms || 9e9) - (b.ms || 9e9)).slice(0, n * 3);
      for (let i = pool.length - 1; i > 0; i--) {
        if (Math.random() < 0.5) { const j = Math.max(0, i - 2); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      }
      return pool.slice(0, n);
    },
    ok(p) { bad.delete(key(p)); },
    fail(p) { bad.set(key(p), Date.now() + 10 * 60 * 1000); },
    get updated() { return updated; },
  };
}
