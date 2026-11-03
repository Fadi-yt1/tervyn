// Tervyn service worker. Catches requests made by proxied pages that escaped
// link rewriting (built by scripts at runtime) and sends them through the gateway.
'use strict';
var P = '/p/';
var INTERNAL = /^\/(__tervyn\/|sw\.js$|go$|robots\.txt$)/;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

function decode(pathname, search) {
  var m = pathname.match(/^\/p\/(https?)\/([^/?#]+)(\/.*)?$/i);
  if (!m) return null;
  try { return new URL(m[1] + '://' + m[2] + (m[3] || '/') + (search || '')); } catch (e) { return null; }
}
function encode(u) {
  return P + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search;
}

// Which proxied site made this request? null = the Tervyn home page or unknown.
function siteOf(event) {
  var fromUrl = function (s) {
    if (!s) return null;
    try { var u = new URL(s); return u.origin === self.location.origin ? decode(u.pathname, u.search) : null; } catch (e) { return null; }
  };
  var byRef = fromUrl(event.request.referrer);
  if (byRef || !event.clientId) return Promise.resolve(byRef);
  return self.clients.get(event.clientId).then(function (c) { return c ? fromUrl(c.url) : null; }, function () { return null; });
}

function forward(req, url) {
  var init = {
    method: req.method,
    headers: req.headers,
    credentials: 'same-origin',
    redirect: req.redirect === 'manual' ? 'manual' : 'follow',
    cache: req.cache === 'only-if-cached' ? 'default' : req.cache,
  };
  if (req.method === 'GET' || req.method === 'HEAD') return fetch(url, init);
  return req.arrayBuffer().then(function (body) { init.body = body; return fetch(url, init); });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  var same = url.origin === self.location.origin;
  if (same && (url.pathname.indexOf(P) === 0 || INTERNAL.test(url.pathname))) return; // already on the gateway
  if (same && req.mode === 'navigate' && url.pathname === '/') return; // the Tervyn home page

  event.respondWith(siteOf(event).then(function (site) {
    if (!site) return fetch(req); // the Tervyn UI itself (e.g. pinging other gateways)
    var real = same ? new URL(url.pathname + url.search, site) : url;
    var proxied = encode(real);
    if (req.mode === 'navigate') return Response.redirect(proxied, 302);
    return forward(req, proxied);
  }));
});
