import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteHtml, rewriteCss, rewriteSetCookie, rewriteLocation, rewriteLinkHeader } from '../gateway/rewrite.js';

const base = 'https://site.com/blog/post.html';

test('HTML links, sources and forms are proxied', () => {
  const html = `<!doctype html><html><head><title>a <b> c</title><link rel=stylesheet href="/s.css" integrity="sha384-x">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'"><meta name="referrer" content="no-referrer"></head>
<body><a href="https://other.com/x?a=1&amp;b=2">o</a><img src='i.png' srcset="a.png 1x, //cdn.com/b.png 2x" alt="">
<form action="/login" method=post><button formaction=/alt>x</button></form><a href="#top">t</a><a href="mailto:x@y.z">m</a>
<div style="background:url('/bg.jpg')"></div><style>.a{background:url(/s.png)}@import "/i.css";</style>
<script>if (a<b && c>d) { el.innerHTML = '<a href="/x">'; }</script><script src="/app.js" async></script></body></html>`;
  const out = rewriteHtml(html, base, { inject: '<script src="/__tervyn/client.js"></script>' });
  assert.match(out, /<head><script src="\/__tervyn\/client.js"><\/script><title>/);
  assert.match(out, /<title>a <b> c<\/title>/);
  assert.match(out, /href="\/p\/https\/site.com\/s.css"/);
  assert.doesNotMatch(out, /integrity/);
  assert.doesNotMatch(out, /Content-Security-Policy/);
  assert.doesNotMatch(out, /no-referrer/);
  assert.match(out, /href="\/p\/https\/other.com\/x\?a=1&amp;b=2"/);
  assert.match(out, /src='\/p\/https\/site.com\/blog\/i.png'/);
  assert.match(out, /srcset="\/p\/https\/site.com\/blog\/a.png 1x, \/p\/https\/cdn.com\/b.png 2x"/);
  assert.match(out, /action="\/p\/https\/site.com\/login" method=post/);
  assert.match(out, /formaction="\/p\/https\/site.com\/alt"/);
  assert.match(out, /href="#top"/);
  assert.match(out, /href="mailto:x@y.z"/);
  assert.match(out, /style="background:url\('\/p\/https\/site.com\/bg.jpg'\)"/);
  assert.match(out, /url\(\/p\/https\/site.com\/s.png\)/);
  assert.match(out, /@import "\/p\/https\/site.com\/i.css"/);
  // script bodies are left alone; the service worker covers what they load
  assert.match(out, /if \(a<b && c>d\) \{ el.innerHTML = '<a href="\/x">'; \}/);
  assert.match(out, /<script src="\/p\/https\/site.com\/app.js" async>/);
});

test('<base href> changes how later links resolve', () => {
  const out = rewriteHtml('<head><base href="https://cdn.site.com/v2/"></head><img src="a.png">', base);
  assert.match(out, /<base href="\/p\/https\/cdn.site.com\/v2\/">/);
  assert.match(out, /src="\/p\/https\/cdn.site.com\/v2\/a.png"/);
});

test('script is injected even without <head>', () => {
  assert.match(rewriteHtml('<html><p>x', base, { inject: '<s>' }), /^<html><s><p>x/);
  assert.match(rewriteHtml('<p>x', base, { inject: '<s>' }), /^<s><p>x/);
});

test('meta refresh is proxied', () => {
  const out = rewriteHtml('<meta http-equiv="refresh" content="0; url=/next">', base);
  assert.match(out, /content="0; url=\/p\/https\/site.com\/next"/);
});

test('CSS', () => {
  assert.equal(rewriteCss('a{b:url("../x.woff2")}', base), 'a{b:url("/p/https/site.com/x.woff2")}');
  assert.equal(rewriteCss('a{b:url(data:image/png;base64,AA)}', base), 'a{b:url(data:image/png;base64,AA)}');
});

test('cookies are scoped to the site path', () => {
  const t = new URL(base);
  assert.equal(rewriteSetCookie('sid=1; Domain=.site.com; Path=/; HttpOnly; Secure; SameSite=None', t),
    'sid=1; HttpOnly; Secure; SameSite=Lax; Path=/p/https/site.com/');
  assert.equal(rewriteSetCookie('__Host-x=1; Path=/; Secure', t), '__Host_x=1; Secure; Path=/p/https/site.com/');
  assert.equal(rewriteSetCookie('a=b', t), 'a=b; Path=/p/https/site.com/');
});

test('headers', () => {
  const t = new URL(base);
  assert.equal(rewriteLocation('/login', t), '/p/https/site.com/login');
  assert.equal(rewriteLocation('https://x.com/', t), '/p/https/x.com/');
  assert.equal(rewriteLinkHeader('</a.css>; rel=preload, <https://f.com/b.woff2>; rel=preload', t),
    '</p/https/site.com/a.css>; rel=preload, </p/https/f.com/b.woff2>; rel=preload');
});
