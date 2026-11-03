// Tervyn Gateway for Node (free VMs: Oracle Cloud Always Free, Google Cloud e2-micro,
// AWS free tier, or any container host). Put Caddy in front for HTTPS + HTTP/2 + HTTP/3
// (see platforms/node/Caddyfile and docker-compose.yml).
//
//   PORT=8080 node platforms/node/server.mjs
//
// Environment:
//   PORT          listen port (default 8080)
//   HOST          listen address (default 0.0.0.0)
//   GATEWAYS      other gateway URLs, comma separated (added to gateways.json)
//   EXITS=1       offer free exit countries (tests the public free proxy lists)
//   REGION        label shown in the gateway list, e.g. "Frankfurt"
//   TRUST_PROXY=1 read the client IP and scheme from X-Forwarded-* (when behind Caddy)
//   RATE_LIMIT    requests per minute per IP (default 900)
//   CACHE_MB      memory for the static asset cache (default 128, 0 = off)
import http from 'node:http';
import zlib from 'node:zlib';
import { Readable, pipeline } from 'node:stream';
import { createGateway } from '../../gateway/core.js';
import { createUpstream } from './upstream.mjs';
import { createMemoryCache } from './cache.mjs';
import { createExitPool } from './exits.mjs';

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|xhtml\+xml|manifest\+json|ld\+json)|image\/svg\+xml)/i;

export function createNodeGateway(env = process.env) {
  const exits = env.EXITS === '1' ? createExitPool() : null;
  const cacheMb = Number(env.CACHE_MB ?? 128);
  const allowPrivate = env.ALLOW_PRIVATE === '1';
  const handler = createGateway({
    platform: 'node',
    fetch: createUpstream({ allowPrivate, exits }),
    cache: cacheMb > 0 ? createMemoryCache({ maxBytes: cacheMb * 1024 * 1024 }) : null,
    gateways: (env.GATEWAYS || '').split(','),
    exits,
    allowPrivate,
    rateLimit: Number(env.RATE_LIMIT ?? 900),
    info: () => ({ region: env.REGION || '' }),
  });
  const trustProxy = env.TRUST_PROXY === '1';

  const server = http.createServer(async (req, res) => {
    try {
      const fwdProto = trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const scheme = fwdProto || (req.socket.encrypted ? 'https' : 'http');
      const host = req.headers.host || 'localhost';
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]); } catch { /* skip bad header */ }
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`${scheme}://${host}${req.url.startsWith('/') ? req.url : '/'}`, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      const clientIp = trustProxy
        ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
        : req.socket.remoteAddress;

      const response = await handler(request, { clientIp });

      const out = {};
      for (const [k, v] of response.headers) if (k !== 'set-cookie') out[k] = v;
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;

      // Brotli (quality 4: nearly gzip speed, smaller output) for text the browser can take.
      const accept = String(req.headers['accept-encoding'] || '');
      const type = response.headers.get('content-type') || '';
      let enc = '';
      if (response.body && COMPRESSIBLE.test(type) && !response.headers.has('content-encoding') && !response.headers.has('content-range')) {
        enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : '';
      }
      if (enc) { out['content-encoding'] = enc; delete out['content-length']; out.vary = out.vary ? `${out.vary}, Accept-Encoding` : 'Accept-Encoding'; }
      res.writeHead(response.status, out);
      if (!response.body) return res.end();
      const body = Readable.fromWeb(response.body);
      if (!enc) return pipeline(body, res, () => {});
      const z = enc === 'br'
        ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }, flush: zlib.constants.BROTLI_OPERATION_FLUSH })
        : zlib.createGzip({ level: 5, flush: zlib.constants.Z_SYNC_FLUSH });
      pipeline(body, z, res, () => {});
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Gateway error');
      console.error('gateway error:', e?.message || e);
    }
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0; // long downloads and streams are fine
  return { server, exits };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, exits } = createNodeGateway();
  const port = Number(process.env.PORT || 8080);
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Tervyn gateway on http://localhost:${port}${exits ? ' (free exit countries on)' : ''}`);
    exits?.start();
  });
}
