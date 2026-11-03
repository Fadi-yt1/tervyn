// Fetch through a free proxy ("exit country") over a raw TCP socket.
// Platform-neutral: the adapter passes openSocket(host, port), which returns
// { readable, writable, close(), startTls?(servername) } (Cloudflare `connect()`,
// Deno.connect, or Node in tests). HTTPS stays end-to-end encrypted between the
// gateway and the site: the free proxy only relays bytes it cannot read.

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');
const CRLF = enc.encode('\r\n');
const CRLF2 = enc.encode('\r\n\r\n');
const HANDSHAKE_MS = 8000;

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
function indexOf(buf, seq, from = 0) {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

// Buffered reader over a ReadableStream of bytes.
class ByteReader {
  constructor(readable) { this.r = readable.getReader(); this.buf = new Uint8Array(0); this.eof = false; }
  async fill() {
    if (this.eof) return false;
    const { value, done } = await this.r.read();
    if (done) { this.eof = true; return false; }
    this.buf = concat(this.buf, value instanceof Uint8Array ? value : new Uint8Array(value));
    return true;
  }
  async readUntil(seq, max = 65536) {
    let from = 0;
    for (;;) {
      const i = indexOf(this.buf, seq, from);
      if (i >= 0) { const out = this.buf.subarray(0, i + seq.length); this.buf = this.buf.slice(i + seq.length); return out; }
      if (this.buf.length > max) throw new Error('response header too large');
      from = Math.max(0, this.buf.length - seq.length);
      if (!(await this.fill())) throw new Error('connection closed early');
    }
  }
  async readExact(n) {
    while (this.buf.length < n) if (!(await this.fill())) throw new Error('connection closed early');
    const out = this.buf.slice(0, n); this.buf = this.buf.slice(n); return out;
  }
  // Up to n bytes (at least 1), or null at end of stream.
  async readUpTo(n) {
    if (!this.buf.length && !(await this.fill())) return null;
    const take = Math.min(n, this.buf.length);
    const out = this.buf.slice(0, take); this.buf = this.buf.slice(take); return out;
  }
  release() { try { this.r.releaseLock(); } catch { /* already released */ } }
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}

async function handshake(br, writer, proxy, host, port) {
  if (proxy.proto === 'http') {
    const auth = proxy.user ? `Proxy-Authorization: Basic ${btoa(`${proxy.user}:${proxy.pass || ''}`)}\r\n` : '';
    await writer.write(enc.encode(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`));
    const head = dec.decode(await br.readUntil(CRLF2, 16384));
    const line = head.split('\r\n')[0];
    if (!/^HTTP\/1\.[01] 200/.test(line)) throw new Error(`proxy refused: ${line.slice(0, 60)}`);
  } else {
    await writer.write(new Uint8Array(proxy.user ? [5, 2, 0, 2] : [5, 1, 0]));
    const hello = await br.readExact(2);
    if (hello[0] !== 5 || (hello[1] !== 0 && hello[1] !== 2)) throw new Error('SOCKS5 proxy refused');
    if (hello[1] === 2) {
      if (!proxy.user) throw new Error('SOCKS5 proxy wants a login');
      const u = enc.encode(proxy.user); const pw = enc.encode(proxy.pass || '');
      const msg = new Uint8Array(3 + u.length + pw.length);
      msg.set([1, u.length]); msg.set(u, 2); msg[2 + u.length] = pw.length; msg.set(pw, 3 + u.length);
      await writer.write(msg);
      const ok = await br.readExact(2);
      if (ok[1] !== 0) throw new Error('SOCKS5 login rejected');
    }
    const name = enc.encode(host);
    const req = new Uint8Array(7 + name.length);
    req.set([5, 1, 0, 3, name.length]); req.set(name, 5); req.set([port >> 8, port & 255], 5 + name.length);
    await writer.write(req);
    const head = await br.readExact(5);
    if (head[1] !== 0) throw new Error(`SOCKS5 error ${head[1]}`);
    const rest = head[3] === 1 ? 5 : head[3] === 4 ? 17 : head[3] === 3 ? head[4] + 2 : 0;
    await br.readExact(rest);
  }
}

// HTTP/1.1 response body as a stream (chunked, fixed length, or until close).
function bodyStream(br, headers, done) {
  const te = (headers.get('transfer-encoding') || '').toLowerCase();
  const len = headers.get('content-length');
  let remaining = len != null && /^\d+$/.test(len) ? Number(len) : -1;
  const chunked = te.includes('chunked');
  let chunkLeft = 0;
  let finished = false;
  const finish = (c) => { if (!finished) { finished = true; c.close(); done(); } };
  return new ReadableStream({
    async pull(c) {
      try {
        if (chunked) {
          if (chunkLeft === 0) {
            const size = parseInt(dec.decode(await br.readUntil(CRLF, 1024)), 16);
            if (!size) { // last chunk: skip trailers up to the empty line
              for (;;) { const l = await br.readUntil(CRLF, 8192); if (l.length <= 2) break; }
              return finish(c);
            }
            chunkLeft = size;
          }
          const part = await br.readUpTo(chunkLeft);
          if (!part) throw new Error('connection closed mid-body');
          chunkLeft -= part.length;
          if (chunkLeft === 0) await br.readExact(2);
          c.enqueue(part);
        } else if (remaining >= 0) {
          if (remaining === 0) return finish(c);
          const part = await br.readUpTo(remaining);
          if (!part) return finish(c);
          remaining -= part.length;
          c.enqueue(part);
          if (remaining === 0) finish(c);
        } else {
          const part = await br.readUpTo(65536);
          if (!part) return finish(c);
          c.enqueue(part);
        }
      } catch (e) { finished = true; done(); c.error(e); }
    },
    cancel() { done(); },
  });
}

const SKIP_REQ = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'upgrade', 'content-length', 'accept-encoding']);

// One request through one proxy. Errors before the site answered are marked .tunnel.
export async function fetchViaProxy(openSocket, proxy, url, init = {}, body = null) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port || (secure ? 443 : 80));
  let sock;
  let br;
  let writer;
  let stage = 'connect';
  const close = () => { try { writer?.releaseLock(); } catch { /* ignore */ } try { sock?.close(); } catch { /* closed */ } };
  try {
    await withTimeout((async () => {
      sock = await openSocket(proxy.address, proxy.port);
      br = new ByteReader(sock.readable);
      writer = sock.writable.getWriter();
      stage = 'proxy-handshake';
      await handshake(br, writer, proxy, u.hostname, port);
      if (secure) {
        stage = 'tls';
        if (br.buf.length) throw new Error('proxy sent unexpected data');
        br.release(); writer.releaseLock();
        sock = await sock.startTls(u.hostname);
        br = new ByteReader(sock.readable);
        writer = sock.writable.getWriter();
      }
    })(), HANDSHAKE_MS, 'free proxy did not answer in time');
  } catch (e) {
    close();
    e.tunnel = true;
    e.stage = stage;
    throw e;
  }
  stage = 'request';
  if (init.signal) init.signal.addEventListener('abort', close, { once: true });

  const lines = [`${init.method || 'GET'} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
  for (const [k, v] of new Headers(init.headers || {})) if (!SKIP_REQ.has(k.toLowerCase())) lines.push(`${k}: ${v}`);
  lines.push('Accept-Encoding: gzip, deflate', 'Connection: close');
  if (body) lines.push(`Content-Length: ${body.byteLength}`);
  try {
    await withTimeout((async () => {
      await writer.write(enc.encode(lines.join('\r\n') + '\r\n\r\n'));
      if (body?.byteLength) await writer.write(body);
    })(), HANDSHAKE_MS, 'sending through the free proxy timed out');
  } catch (e) { close(); e.tunnel = true; e.stage = stage; throw e; }

  // Response head (skip 1xx informational answers).
  let status = 0;
  let headLines = [];
  try {
    for (;;) {
      headLines = dec.decode(await br.readUntil(CRLF2)).split('\r\n');
      status = parseInt(headLines[0].slice(9, 12), 10);
      if (!(status >= 100 && status < 200)) break;
    }
  } catch (e) { close(); e.tunnel = true; e.stage = 'response'; throw e; }
  if (!(status >= 200 && status <= 599)) { close(); const e = new Error('bad response from site'); e.tunnel = true; throw e; }

  const headers = new Headers();
  for (const l of headLines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) { try { headers.append(l.slice(0, i).trim(), l.slice(i + 1).trim()); } catch { /* bad header */ } }
  }
  const noBody = init.method === 'HEAD' || status === 204 || status === 304;
  let stream = noBody ? null : bodyStream(br, headers, close);
  if (noBody) close();
  const ce = (headers.get('content-encoding') || '').toLowerCase().trim();
  if (stream && (ce === 'gzip' || ce === 'x-gzip' || ce === 'deflate')) {
    stream = stream.pipeThrough(new DecompressionStream(ce === 'deflate' ? 'deflate' : 'gzip'));
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  headers.delete('transfer-encoding');
  headers.set('x-tervyn-exit', proxy.code || '??');
  return new Response(stream, { status, headers });
}

// Wraps a platform fetch: requests with meta.exit go through that country's free proxies.
export function exitFetch({ baseFetch, openSocket, exits, tries = 3 }) {
  return async (url, init = {}, meta = {}) => {
    if (!meta.exit || !exits) return baseFetch(url, init, meta);
    const proxies = await exits.pick(meta.exit, tries);
    if (!proxies.length) throw new Error(`${/^P\d+$/.test(meta.exit) ? `Your server ${meta.exit.slice(1)} isn't answering` : `No working free server in ${meta.exit}`} right now. Pick another location, or browse without one.`);
    const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null;
    let last;
    for (const p of proxies) {
      try {
        const res = await fetchViaProxy(openSocket, p, url, init, body);
        exits.ok?.(p);
        return res;
      } catch (e) {
        last = e;
        if (!e.tunnel) break;
        exits.fail?.(p);
      }
    }
    throw new Error(`The ${/^P\d+$/.test(meta.exit) ? `server ${meta.exit.slice(1)}` : `free servers in ${meta.exit}`} didn't answer (${String(last?.message || last).slice(0, 120)}). Try again or pick another country.`);
  };
}

// Diagnostics: try a few proxies of one country and report where each one stops.
export async function checkExits(openSocket, exits, code, target = 'https://api.ipify.org/?format=json', n = 5) {
  const list = await exits.pick(code, n);
  return Promise.all(list.map(async (p) => {
    const t0 = Date.now();
    try {
      const r = await fetchViaProxy(openSocket, p, target);
      return { proxy: `${p.proto}://${p.address}:${p.port}`, ok: true, status: r.status, ms: Date.now() - t0, body: (await r.text()).slice(0, 120) };
    } catch (e) {
      return { proxy: `${p.proto}://${p.address}:${p.port}`, ok: false, stage: e.stage || '?', ms: Date.now() - t0, error: String(e.message || e).slice(0, 160) };
    }
  }));
}
