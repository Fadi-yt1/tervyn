// Cloudflare Workers (free plan: 100,000 requests/day, 300+ cities, HTTP/3 on by default).
//   npx wrangler deploy          (uses wrangler.toml in the repo root)
import { createGateway } from '../../gateway/core.js';
import { streamHtml, canStream } from '../../gateway/htmlrewriter.js';
import { exitFetch } from '../../gateway/tunnel.js';
import { createRemoteExits } from '../../gateway/exits-remote.js';
import { connect } from 'cloudflare:sockets';

// Raw TCP to a free proxy, upgraded to TLS for https sites (end-to-end with the site).
async function openSocket(hostname, port) {
  const wrap = (s) => ({
    readable: s.readable,
    writable: s.writable,
    close: () => s.close(),
    startTls: async (servername) => { const t = s.startTls({ expectedServerHostname: servername }); await t.opened; return wrap(t); },
  });
  const s = connect({ hostname, port }, { secureTransport: 'starttls' });
  await s.opened;
  return wrap(s);
}

let gateway;
function edgeCache() {
  if (typeof caches === 'undefined' || !caches.default) return null;
  return {
    match: (key) => caches.default.match(new Request(key)),
    put: (key, res) => caches.default.put(new Request(key), res),
  };
}

export default {
  async fetch(request, env, ctx) {
    const exits = env.PROXY_LIST_URL ? (globalThis.__tervynExits ||= createRemoteExits({
      url: env.PROXY_LIST_URL,
      fetchList: (u) => fetch(u, { cf: { cacheTtl: 300, cacheEverything: true } }),
    })) : null;
    gateway ||= createGateway({
      platform: 'cloudflare',
      exits,
      // Requests with an exit country tunnel through that country's free proxies.
      fetch: exitFetch({ baseFetch: (url, init) => fetch(url, init), openSocket, exits }),
      gateways: String(env.GATEWAYS || '').split(','),
      rateLimit: Number(env.RATE_LIMIT || 900),
      contact: env.CONTACT || '',
      cache: edgeCache(),
      allowPrivate: env.ALLOW_PRIVATE === '1', // local `wrangler dev` testing only
      // Native, streaming HTML rewriting keeps big pages under the free plan's CPU limit.
      streamHtml: typeof HTMLRewriter === 'undefined' ? null : {
        canStream,
        transform: (res, base, inject) => streamHtml(HTMLRewriter, res, base, inject),
      },
      // WebSockets: hand the browser the site's WebSocket directly.
      websocket: async (req, target, headers) => {
        headers.set('upgrade', 'websocket');
        const res = await fetch(target.href, { headers });
        if (res.status !== 101 || !res.webSocket) return new Response('The site refused the WebSocket connection.', { status: 502 });
        return res;
      },
      info: (req) => ({ colo: req.cf?.colo || '', country: req.cf?.country || '' }),
    });
    return gateway(request, {
      clientIp: request.headers.get('cf-connecting-ip') || '',
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
};
