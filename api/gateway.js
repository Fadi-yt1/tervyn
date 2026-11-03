// Vercel Edge Function (Hobby plan is free). vercel.json sends every path here.
//   npx vercel deploy --prod
import { createGateway } from '../gateway/core.js';

export const config = { runtime: 'edge' };

const gateway = createGateway({
  platform: 'vercel',
  gateways: String(process.env.GATEWAYS || '').split(','),
  rateLimit: Number(process.env.RATE_LIMIT || 900),
  contact: process.env.CONTACT || '',
  // Countries are served by the Node function next to this one (api/exit.js).
  exitsElsewhere: true,
  info: (req) => {
    // x-vercel-id looks like "fra1::iad1::abc": the edge region comes first.
    const id = req.headers.get('x-vercel-id') || '';
    return { region: id.split('::')[0] || process.env.VERCEL_REGION || '' };
  },
});

export default function handler(request) {
  // vercel.json rewrites "/<path>" to "/api/gateway?tervyn_path=/<path>". Put the original URL back.
  const url = new URL(request.url);
  const original = url.searchParams.get('tervyn_path');
  if (original != null && url.pathname.startsWith('/api/gateway')) {
    url.searchParams.delete('tervyn_path');
    const fixed = new URL(original + url.search, url.origin);
    const init = { method: request.method, headers: request.headers };
    if (!['GET', 'HEAD'].includes(request.method)) { init.body = request.body; init.duplex = 'half'; }
    request = new Request(fixed, init);
  }
  const ip = (request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return gateway(request, { clientIp: ip });
}
