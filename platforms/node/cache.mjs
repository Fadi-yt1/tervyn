// Small in-memory LRU cache for public static assets (CSS, JS, images, fonts).
// Same match/put shape as the Cloudflare/Deno Cache API, so core.js treats them alike.
export function createMemoryCache({ maxBytes = 128 * 1024 * 1024, maxEntry = 4 * 1024 * 1024 } = {}) {
  const map = new Map(); // key -> { status, headers, body, expires, size }
  let total = 0;

  function ttlOf(headers) {
    const cc = headers.get('cache-control') || '';
    const m = cc.match(/s-maxage=(\d+)/i) || cc.match(/max-age=(\d+)/i);
    if (m) return Math.min(Number(m[1]), 86400) * 1000;
    const exp = Date.parse(headers.get('expires') || '');
    return Number.isFinite(exp) ? Math.min(Math.max(exp - Date.now(), 0), 86400000) : 0;
  }
  function drop(key) {
    const e = map.get(key);
    if (e) { total -= e.size; map.delete(key); }
  }

  return {
    async match(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.expires < Date.now()) { drop(key); return undefined; }
      map.delete(key); map.set(key, e); // most recently used goes last
      return new Response(e.body, { status: e.status, headers: e.headers });
    },
    async put(key, res) {
      const ttl = ttlOf(res.headers);
      if (ttl <= 0) { await res.body?.cancel(); return; }
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > maxEntry) return;
      drop(key);
      const headers = new Headers(res.headers);
      map.set(key, { status: res.status, headers, body, expires: Date.now() + ttl, size: body.byteLength + 512 });
      total += body.byteLength + 512;
      for (const k of map.keys()) { if (total <= maxBytes) break; drop(k); }
    },
    get size() { return map.size; },
    get bytes() { return total; },
  };
}
