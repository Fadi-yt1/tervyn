// Tries the published free proxies for some countries with the same tunnel code the
// gateways use, and prints where each one stops.  node scripts/check-exits.mjs <proxies.json URL> US CA
import { checkExits } from '../gateway/tunnel.js';
import { createRemoteExits } from '../gateway/exits-remote.js';
import { openSocket } from '../platforms/node/socket.mjs';

const [url, ...codes] = process.argv.slice(2);
const exits = createRemoteExits({ url });
for (const cc of codes.length ? codes : ['US', 'CA']) {
  for (const r of await checkExits(openSocket, exits, cc, 'https://api.ipify.org/?format=json', 6)) {
    console.log(cc, r.ok ? 'OK ' : 'ERR', r.proxy, `${r.ms}ms`, r.ok ? `${r.status} ${r.body}` : `[${r.stage}] ${r.error}`);
  }
}
