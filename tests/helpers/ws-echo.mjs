// Minimal WebSocket echo endpoint for tests (no dependencies). Text frames only.
import crypto from 'node:crypto';

export function attachWsEcho(server, path = '/ws') {
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith(path)) return socket.destroy();
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 15;
        let len = buf[1] & 127; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        const masked = buf[1] & 128;
        if (buf.length < off + (masked ? 4 : 0) + len) return;
        const mask = masked ? buf.subarray(off, off + 4) : null; off += masked ? 4 : 0;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (op === 1) {
          const msg = Buffer.from('echo:' + payload.toString());
          const head = msg.length < 126 ? Buffer.from([0x81, msg.length]) : Buffer.from([0x81, 126, msg.length >> 8, msg.length & 255]);
          socket.write(Buffer.concat([head, msg]));
        }
      }
    });
    socket.on('error', () => {});
  });
}

// Opens a WebSocket (Node 22 global), sends one message, resolves with the reply.
export function wsRoundTrip(url, text = 'hi', ms = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, ms);
    ws.onopen = () => ws.send(text);
    ws.onmessage = (e) => { clearTimeout(t); resolve(String(e.data)); ws.close(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket error')); };
  });
}
