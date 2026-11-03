// Vercel and Netlify adapters, run in Node with platform-shaped requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vercel from '../api/gateway.js';
import netlify from '../netlify/edge-functions/gateway.js';

test('vercel: the rewritten path is restored', async () => {
  const ping = await vercel(new Request('https://t.vercel.app/api/gateway?tervyn_path=/__tervyn/ping', { headers: { 'x-vercel-id': 'fra1::iad1::x' } }));
  const body = await ping.json();
  assert.equal(body.platform, 'vercel');
  assert.equal(body.region, 'fra1');
  const go = await vercel(new Request('https://t.vercel.app/api/gateway?tervyn_path=/go&url=example.com%2Fa%3Fb%3D1'));
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), '/p/https/example.com/a?b=1');
  // If the platform already passes the original URL, it is used as is.
  const direct = await vercel(new Request('https://t.vercel.app/go?url=wikipedia.org'));
  assert.equal(direct.headers.get('location'), '/p/https/wikipedia.org/');
});

test('netlify: ping reports region and country', async () => {
  const res = await netlify(new Request('https://t.netlify.app/__tervyn/ping'), { ip: '1.2.3.4', server: { region: 'us-east-2' }, geo: { country: { code: 'US' } } });
  const body = await res.json();
  assert.equal(body.platform, 'netlify');
  assert.equal(body.region, 'us-east-2');
  assert.equal(body.country, 'US');
  const blocked = await netlify(new Request('https://t.netlify.app/p/http/169.254.169.254/'), { ip: '1.2.3.4' });
  assert.equal(blocked.status, 403);
});

test('vercel: the routing parameter never reaches the site', async () => {
  // Newer Vercel versions keep the original path and only append tervyn_path.
  const r = await vercel(new Request('https://t.vercel.app/go?url=example.com%2Fa&tervyn_path=%2Fgo'));
  assert.equal(r.headers.get('location'), '/p/https/example.com/a');
  const ping = await vercel(new Request('https://t.vercel.app/__tervyn/ping?tervyn_path=%2F__tervyn%2Fping'));
  assert.equal((await ping.json()).platform, 'vercel');
});
