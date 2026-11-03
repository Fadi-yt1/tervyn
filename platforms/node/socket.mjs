// A Node TCP socket shaped like Cloudflare's connect(): web streams plus startTls().
import net from 'node:net';
import tls from 'node:tls';

function wrap(sock) {
  let onData, onEnd, onErr;
  let ctl;
  const readable = new ReadableStream({
    start(c) {
      ctl = c;
      onData = (d) => { c.enqueue(new Uint8Array(d)); if (c.desiredSize <= 0) sock.pause(); };
      onEnd = () => { try { c.close(); } catch { /* closed */ } };
      onErr = (e) => { try { c.error(e); } catch { /* closed */ } };
      sock.on('data', onData); sock.on('end', onEnd); sock.on('error', onErr);
    },
    pull() { sock.resume(); },
    cancel() { sock.destroy(); },
  });
  const writable = new WritableStream({
    write: (chunk) => new Promise((res, rej) => sock.write(chunk, (e) => (e ? rej(e) : res()))),
    close: () => new Promise((res) => sock.end(res)),
    abort: () => sock.destroy(),
  });
  return {
    readable,
    writable,
    close: () => sock.destroy(),
    // Hand the raw socket to TLS: stop feeding the old stream first.
    startTls: (servername) => new Promise((res, rej) => {
      sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onErr);
      try { ctl.close(); } catch { /* closed */ }
      const t = tls.connect({ socket: sock, servername, ALPNProtocols: ['http/1.1'] });
      t.once('secureConnect', () => res(wrap(t)));
      t.once('error', rej);
    }),
  };
}

export function openSocket(host, port) {
  return new Promise((res, rej) => {
    const s = net.connect({ host, port });
    s.setNoDelay(true);
    s.once('connect', () => { s.off('error', rej); res(wrap(s)); });
    s.once('error', rej);
  });
}
