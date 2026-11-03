// Cloudflare Workers (free plan: 100,000 requests/day, 300+ cities, HTTP/3 on by default).
//   npx wrangler deploy          (uses wrangler.toml in the repo root)
import { createGateway } from '../../gateway/core.js';

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
    gateway ||= createGateway({
      platform: 'cloudflare',
      gateways: String(env.GATEWAYS || '').split(','),
      rateLimit: Number(env.RATE_LIMIT || 900),
      cache: edgeCache(),
      allowPrivate: env.ALLOW_PRIVATE === '1', // local `wrangler dev` testing only
      info: (req) => ({ colo: req.cf?.colo || '', country: req.cf?.country || '' }),
    });
    return gateway(request, {
      clientIp: request.headers.get('cf-connecting-ip') || '',
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
};
