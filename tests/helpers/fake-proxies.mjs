// Fake free proxies for tests: HTTP CONNECT, SOCKS5, and a dead one that hangs up.
import net from 'node:net';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

export async function startFakeProxies() {
  const pipeTo = (client, host, port, first) => {
    const up = net.connect(port, host, () => { client.write(first); client.pipe(up).pipe(client); });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  };
  const connect = net.createServer((c) => {
    c.once('data', (d) => {
      const m = d.toString().match(/^CONNECT ([^:]+):(\d+)/);
      if (!m) return c.destroy();
      pipeTo(c, m[1], Number(m[2]), 'HTTP/1.1 200 Connection established\r\n\r\n');
    });
  });
  const socks = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (d) => {
        const len = d[4];
        pipeTo(c, d.subarray(5, 5 + len).toString(), d.readUInt16BE(5 + len), Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
  });
  const dead = net.createServer((c) => c.destroy());
  const [connectPort, socksPort, deadPort] = [await listen(connect), await listen(socks), await listen(dead)];
  return { connectPort, socksPort, deadPort, close() { connect.close(); socks.close(); dead.close(); } };
}
