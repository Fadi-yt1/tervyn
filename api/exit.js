// Vercel Node.js function for country browsing (free proxies). Raw TCP + TLS through
// HTTP CONNECT / SOCKS5 proxies needs Node; the edge gateway (api/gateway.js) can't.
// vercel.json sends requests here when the tervyn_exit cookie holds a country code.
import { createNodeGateway } from '../platforms/node/server.mjs';

const { listener } = createNodeGateway({
  ...process.env,
  TRUST_PROXY: '1',
  CACHE_MB: '32',
  REGION: process.env.VERCEL_REGION || 'Vercel',
  PROXY_LIST_URL: process.env.PROXY_LIST_URL || 'https://raw.githubusercontent.com/Fadi-yt1/tervyn/proxies/proxies.json',
});

export default function handler(req, res) {
  // vercel.json rewrites "/<path>" to "/api/exit?tervyn_path=/<path>": put the original path back.
  const u = new URL(req.url, 'http://x');
  const original = u.searchParams.get('tervyn_path');
  if (original != null) {
    u.searchParams.delete('tervyn_path');
    const qs = u.searchParams.toString();
    req.url = original + (qs ? `?${qs}` : '');
  }
  return listener(req, res);
}
