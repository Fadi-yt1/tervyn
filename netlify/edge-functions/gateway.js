// Netlify Edge Function (free Starter plan).   npx netlify deploy --prod
import { createGateway } from '../../gateway/core.js';

const env = (k) => { try { return globalThis.Netlify?.env.get(k) || ''; } catch { return ''; } };

const gateway = createGateway({
  platform: 'netlify',
  gateways: env('GATEWAYS').split(','),
  rateLimit: Number(env('RATE_LIMIT') || 900),
  contact: env('CONTACT'),
  info: (req, ctx) => ({ region: ctx.server?.region || '', country: ctx.geo?.country?.code || '' }),
});

export default (request, context) => gateway(request, { clientIp: context.ip, server: context.server, geo: context.geo });

export const config = { path: '/*' };
