// Upstream HTTP client for the Node gateway.
// - Keep-alive connection pools per host, plus TLS session reuse (fewer handshakes).
// - Checks every resolved IP, so a public name that points at a private address is refused.
// - Can send a request through a free public proxy ("exit country"), with pooled tunnels.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { Readable, pipeline, PassThrough } from 'node:stream';
import { isPrivateAddress } from '../../gateway/url.js';

const TIMEOUT = 30000;

function safeLookup(allowPrivate) {
  return (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) {
        const e = new Error(`${host} points to a private network address`);
        e.code = 'EPRIVATE';
        return cb(e);
      }
      if (opts.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

// ---------- tunnels through free proxies (HTTP CONNECT or SOCKS5) ----------

function readUntil(socket, test, ms) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('proxy timeout')), ms);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const n = test(buf);
      if (n > 0) {
        const rest = buf.subarray(n);
        done(null, buf.subarray(0, n));
        if (rest.length) socket.unshift(rest);
      }
    };
    const onErr = (e) => done(e || new Error('proxy closed the connection'));
    const onClose = () => done(new Error('proxy closed the connection'));
    function done(err, val) {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', onErr); socket.off('close', onClose);
      err ? reject(err) : resolve(val);
    }
    socket.on('data', onData); socket.once('error', onErr); socket.once('close', onClose);
  });
}

export async function openTunnel(proxy, host, port, ms = 8000) {
  const socket = net.connect({ host: proxy.address, port: proxy.port });
  socket.setNoDelay(true);
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('proxy connect timeout')), ms);
      socket.once('connect', () => { clearTimeout(t); resolve(); });
      socket.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    if (proxy.proto === 'http') {
      const auth = proxy.user ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass || ''}`).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      const head = await readUntil(socket, (b) => { const i = b.indexOf('\r\n\r\n'); return i < 0 ? 0 : i + 4; }, ms);
      const line = head.toString('latin1').split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(line)) throw new Error(`proxy refused: ${line.slice(0, 60)}`);
    } else {
      // Offer "no login", plus username/password when we have one (RFC 1929).
      socket.write(Buffer.from(proxy.user ? [5, 2, 0, 2] : [5, 1, 0]));
      const hello = await readUntil(socket, (b) => (b.length >= 2 ? 2 : 0), ms);
      if (hello[0] !== 5 || (hello[1] !== 0 && hello[1] !== 2)) throw new Error('SOCKS5 proxy refused');
      if (hello[1] === 2) {
        if (!proxy.user) throw new Error('SOCKS5 proxy wants a login');
        const u = Buffer.from(proxy.user); const pw = Buffer.from(proxy.pass || '');
        socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
        const ok = await readUntil(socket, (b) => (b.length >= 2 ? 2 : 0), ms);
        if (ok[1] !== 0) throw new Error('SOCKS5 login rejected');
      }
      const name = Buffer.from(host);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
      const reply = await readUntil(socket, (b) => {
        if (b.length < 5) return 0;
        const len = b[3] === 1 ? 10 : b[3] === 4 ? 22 : b[3] === 3 ? 7 + b[4] : 0;
        return len && b.length >= len ? len : 0;
      }, ms);
      if (reply[1] !== 0) throw new Error(`SOCKS5 error ${reply[1]}`);
    }
    return socket;
  } catch (e) {
    socket.destroy();
    e.tunnel = true;
    throw e;
  }
}

// Keep-alive agents whose sockets go through one free proxy.
function exitAgents(proxy) {
  const opts = { keepAlive: true, maxSockets: 32, maxFreeSockets: 8, timeout: 60000 };
  const httpAgent = new http.Agent(opts);
  httpAgent.createConnection = (o, cb) => {
    openTunnel(proxy, o.host, Number(o.port) || 80).then((s) => cb(null, s), (e) => cb(e));
  };
  const httpsAgent = new https.Agent(opts);
  httpsAgent.createConnection = (o, cb) => {
    openTunnel(proxy, o.host, Number(o.port) || 443).then((raw) => {
      const s = tls.connect({ socket: raw, servername: o.servername || o.host, ALPNProtocols: ['http/1.1'], session: o.session });
      s.once('secureConnect', () => cb(null, s));
      s.once('error', (e) => { e.tunnel = true; cb(e); });
    }, (e) => cb(e));
  };
  return { 'http:': httpAgent, 'https:': httpsAgent };
}

function decodeBody(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  const dec = enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate' ? zlib.createUnzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
    : enc === 'br' ? zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }) : null;
  if (!dec) return { body: res, decoded: false };
  const out = new PassThrough();
  pipeline(res, dec, out, () => {});
  return { body: out, decoded: true };
}

export function createUpstream({ allowPrivate = false, exits = null } = {}) {
  const lookup = safeLookup(allowPrivate);
  const agentOpts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 256, maxFreeSockets: 64, timeout: 60000, scheduling: 'lifo' };
  const direct = {
    'http:': new http.Agent({ ...agentOpts, lookup }),
    'https:': new https.Agent({ ...agentOpts, lookup, maxCachedSessions: 1000 }),
  };
  const exitPools = new Map();
  const agentsFor = (proxy) => {
    // Per login too: Webshare gives several accounts on the same IP:port.
    const key = `${proxy.proto}://${proxy.user || ""}:${proxy.pass || ""}@${proxy.address}:${proxy.port}`;
    if (!exitPools.has(key)) exitPools.set(key, exitAgents(proxy));
    return exitPools.get(key);
  };

  function once(url, init, agent, proxy) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const headers = {};
      for (const [k, v] of init.headers || []) headers[k] = v;
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, { method: init.method || 'GET', headers, agent, lookup, timeout: TIMEOUT, servername: u.hostname }, (res) => {
        const h = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          try { h.append(res.rawHeaders[i], res.rawHeaders[i + 1]); } catch { /* invalid header from the site */ }
        }
        const status = res.statusCode;
        const nullBody = [204, 205, 304].includes(status) || init.method === 'HEAD';
        if (nullBody) { res.resume(); return resolve(new Response(null, { status, headers: h })); }
        const { body, decoded } = decodeBody(res);
        if (decoded) { h.delete('content-encoding'); h.delete('content-length'); }
        if (proxy) h.set('x-tervyn-exit', proxy.code || '??');
        resolve(new Response(Readable.toWeb(body), { status: status < 200 ? 502 : status, statusText: res.statusMessage, headers: h }));
      });
      req.on('timeout', () => req.destroy(new Error('the site took too long to answer')));
      if (init.signal) {
        if (init.signal.aborted) req.destroy(init.signal.reason);
        else init.signal.addEventListener('abort', () => req.destroy(init.signal.reason), { once: true });
      }
      req.on('error', (e) => { if (proxy && (e.tunnel || e.code === 'ECONNRESET')) e.tunnel = true; reject(e); });
      if (init.body) pipeline(Readable.fromWeb(init.body), req, () => {});
      else req.end();
    });
  }

  return async function upstreamFetch(url, init = {}, meta = {}) {
    const proto = new URL(url).protocol;
    if (meta.exit && exits) {
      const proxies = await exits.pick(meta.exit, 3);
      if (!proxies.length) throw new Error(/^P\d+$/.test(meta.exit) ? `Your server ${meta.exit.slice(1)} isn't answering right now. Pick another one.` : `No working free server in ${meta.exit} right now. Pick another location.`);
      const retryable = !init.body;
      let last;
      for (const p of proxies) {
        try {
          const res = await once(url, init, agentsFor(p)[proto], p);
          exits.ok(p);
          return res;
        } catch (e) {
          last = e;
          if (e.tunnel) exits.fail(p);
          if (!retryable || !e.tunnel) break;
        }
      }
      throw last;
    }
    return once(url, init, direct[proto], null);
  };
}

// WebSocket bridge: opens the upgrade to the site (same SSRF-safe DNS check), then pipes raw sockets.
// `socket` is the browser's socket from the http server's 'upgrade' event.
export function bridgeWebSocket({ socket, head, target, headers, allowPrivate = false }) {
  const lookup = safeLookup(allowPrivate);
  const secure = target.protocol === 'https:';
  const port = Number(target.port || (secure ? 443 : 80));
  const fail = (code, msg) => { try { socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); } catch { socket.destroy(); } };
  const up = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname, lookup, ALPNProtocols: ['http/1.1'] })
    : net.connect({ host: target.hostname, port, lookup });
  const timer = setTimeout(() => { up.destroy(); fail(504, 'Gateway Timeout'); }, 15000);
  up.once(secure ? 'secureConnect' : 'connect', () => {
    const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, 'Connection: Upgrade', 'Upgrade: websocket'];
    for (const [k, v] of headers) if (!/^(host|connection|upgrade)$/i.test(k)) lines.push(`${k}: ${v}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    clearTimeout(timer);
    up.pipe(socket).pipe(up);
  });
  up.on('error', () => { clearTimeout(timer); fail(502, 'Bad Gateway'); });
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
}
