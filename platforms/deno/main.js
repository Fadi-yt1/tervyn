// Deno Deploy (free plan) or any machine with Deno.
//   deno run --allow-net --allow-env platforms/deno/main.js
// Deploy with the `deno deploy` command (see README) using this file as the entrypoint.
import { createGateway } from '../../gateway/core.js';

const env = (k) => { try { return Deno.env.get(k) || ''; } catch { return ''; } };

let cache = null;
try {
  const c = await caches.open('tervyn');
  cache = { match: (k) => c.match(new Request(k)), put: (k, r) => c.put(new Request(k), r) };
} catch { /* no Cache API here */ }

const gateway = createGateway({
  platform: 'deno',
  gateways: env('GATEWAYS').split(','),
  rateLimit: Number(env('RATE_LIMIT') || 900),
  cache,
  allowPrivate: env('ALLOW_PRIVATE') === '1', // local testing only
  info: () => ({ region: env('DENO_REGION') }),
});

Deno.serve({ port: Number(env('PORT') || 8000) }, (request, info) =>
  gateway(request, { clientIp: info?.remoteAddr?.hostname || '' }));
