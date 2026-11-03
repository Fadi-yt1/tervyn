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
  // Same, but they require a login (user "u", password "p"), like Webshare.
  const authConnect = net.createServer((c) => {
    c.once('data', (d) => {
      const text = d.toString();
      const m = text.match(/^CONNECT ([^:]+):(\d+)/);
      const ok = /Proxy-Authorization: Basic (\S+)/i.test(text) && Buffer.from(text.match(/Proxy-Authorization: Basic (\S+)/i)[1], 'base64').toString() === 'u:p';
      if (!m || !ok) { c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      pipeTo(c, m[1], Number(m[2]), 'HTTP/1.1 200 Connection established\r\n\r\n');
    });
  });
  const authSocks = net.createServer((c) => {
    c.once('data', (greet) => {
      if (![...greet.subarray(2)].includes(2)) { c.end(Buffer.from([5, 0xff])); return; }
      c.write(Buffer.from([5, 2]));
      c.once('data', (a) => {
        const ul = a[1]; const user = a.subarray(2, 2 + ul).toString();
        const pl = a[2 + ul]; const pass = a.subarray(3 + ul, 3 + ul + pl).toString();
        if (user !== 'u' || pass !== 'p') { c.end(Buffer.from([1, 1])); return; }
        c.write(Buffer.from([1, 0]));
        c.once('data', (d) => {
          const len = d[4];
          pipeTo(c, d.subarray(5, 5 + len).toString(), d.readUInt16BE(5 + len), Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
      });
    });
  });
  const dead = net.createServer((c) => c.destroy());
  const [connectPort, socksPort, deadPort, authConnectPort, authSocksPort] = [await listen(connect), await listen(socks), await listen(dead), await listen(authConnect), await listen(authSocks)];
  return { connectPort, socksPort, deadPort, authConnectPort, authSocksPort, close() { for (const s of [connect, socks, dead, authConnect, authSocks]) s.close(); } };
}
