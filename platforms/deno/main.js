// Deno Deploy (free plan) or any machine with Deno.
//   deno run --allow-net --allow-env platforms/deno/main.js
// On Deno Deploy, link the GitHub repo and set the entrypoint to this file.
import { createGateway } from '../../gateway/core.js';

const env = (k) => { try { return Deno.env.get(k) || ''; } catch { return ''; } };

let cache = null;
try {
  const c = await caches.open('tervyn');
  cache = { match: (k) => c.match(new Request(k)), put: (k, r) => c.put(new Request(k), r) };
} catch { /* no Cache API here */ }

// Bridges the browser's WebSocket to the site's.
async function websocket(request, target, headers) {
  const protocols = (headers.get('sec-websocket-protocol') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const upstream = new WebSocket(target.href.replace(/^http/, 'ws'), protocols);
  upstream.binaryType = 'arraybuffer';
  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 15000);
    upstream.onopen = () => { clearTimeout(t); resolve(true); };
    upstream.onerror = () => { clearTimeout(t); resolve(false); };
  });
  if (!opened) { try { upstream.close(); } catch { /* closed */ } return new Response('The site refused the WebSocket connection.', { status: 502 }); }
  const { socket, response } = Deno.upgradeWebSocket(request, upstream.protocol ? { protocol: upstream.protocol } : {});
  const pending = [];
  socket.onopen = () => { for (const m of pending.splice(0)) socket.send(m); };
  upstream.onmessage = (e) => { if (socket.readyState === 1) socket.send(e.data); else pending.push(e.data); };
  socket.onmessage = (e) => { if (upstream.readyState === 1) upstream.send(e.data); };
  const closeBoth = (code, reason) => {
    const c = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
    try { if (socket.readyState < 2) socket.close(c, reason); } catch { /* closed */ }
    try { if (upstream.readyState < 2) upstream.close(c, reason); } catch { /* closed */ }
  };
  upstream.onclose = (e) => closeBoth(e.code, e.reason);
  socket.onclose = (e) => closeBoth(e.code, e.reason);
  upstream.onerror = () => closeBoth(1011, '');
  return response;
}

const gateway = createGateway({
  platform: 'deno',
  gateways: env('GATEWAYS').split(','),
  rateLimit: Number(env('RATE_LIMIT') || 900),
  contact: env('CONTACT'),
  cache,
  websocket,
  allowPrivate: env('ALLOW_PRIVATE') === '1', // local testing only
  info: () => ({ region: env('DENO_REGION') }),
});

Deno.serve({ port: Number(env('PORT') || 8000) }, (request, info) =>
  gateway(request, { clientIp: info?.remoteAddr?.hostname || '' }));
