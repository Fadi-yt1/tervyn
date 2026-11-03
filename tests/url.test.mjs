import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTarget, decodeTarget, toProxy, normalizeInput, checkTarget, isPrivateAddress } from '../gateway/url.js';

test('encode / decode round trip', () => {
  assert.equal(encodeTarget('https://example.com/a/b?x=1#h'), '/p/https/example.com/a/b?x=1#h');
  assert.equal(encodeTarget('http://example.com:8080/'), '/p/http/example.com:8080/');
  assert.equal(decodeTarget('/p/https/example.com/a/b', '?x=1').href, 'https://example.com/a/b?x=1');
  assert.equal(decodeTarget('/p/https/example.com').href, 'https://example.com/');
  assert.equal(decodeTarget('/p/ftp/example.com/'), null);
  assert.equal(decodeTarget('/other'), null);
});

test('toProxy resolves relative links against the page', () => {
  const base = 'https://site.com/dir/page.html';
  assert.equal(toProxy('/x.js', base), '/p/https/site.com/x.js');
  assert.equal(toProxy('img/a.png', base), '/p/https/site.com/dir/img/a.png');
  assert.equal(toProxy('//cdn.com/a.css', base), '/p/https/cdn.com/a.css');
  assert.equal(toProxy('http://plain.com/', base), '/p/http/plain.com/');
  for (const keep of ['#top', 'data:image/png;base64,xx', 'javascript:void(0)', 'mailto:a@b.c', '', '/p/https/x.com/']) {
    assert.equal(toProxy(keep, base), keep);
  }
});

test('normalizeInput understands domains, URLs and searches', () => {
  assert.equal(normalizeInput('wikipedia.org').href, 'https://wikipedia.org/');
  assert.equal(normalizeInput('news.ycombinator.com/item?id=1').href, 'https://news.ycombinator.com/item?id=1');
  assert.equal(normalizeInput('http://x.com/a').href, 'http://x.com/a');
  assert.match(normalizeInput('how to cook rice').href, /^https:\/\/duckduckgo\.com\/html\/\?q=how%20to%20cook%20rice$/);
  assert.equal(normalizeInput('  '), null);
});

test('private targets are blocked', () => {
  const bad = ['http://localhost/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest', 'http://192.168.1.1/',
    'http://[::1]/', 'http://[fd00::1]/', 'http://metadata.google.internal/', 'http://router/', 'http://printer.local/',
    'http://2130706433/', 'http://0x7f.1/', 'https://example.com:22/', 'http://user:pw@example.com/'];
  for (const u of bad) assert.notEqual(checkTarget(new URL(u)), '', u);
  for (const u of ['https://example.com/', 'http://93.184.216.34/', 'https://[2606:4700::1111]/']) assert.equal(checkTarget(new URL(u)), '', u);
  assert.equal(checkTarget(new URL('http://127.0.0.1:9999/'), { allowPrivate: true }), '');
  assert.ok(isPrivateAddress('::ffff:10.0.0.1'));
  assert.ok(!isPrivateAddress('8.8.8.8'));
});
