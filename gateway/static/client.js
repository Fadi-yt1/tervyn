// Injected at the top of every proxied page. Keeps links, history and requests
// on the gateway, installs the service worker, and draws the small Tervyn toolbar.
(function () {
  'use strict';
  if (window.__tervyn) return;
  var script = document.currentScript;
  var cfg = {};
  try { cfg = JSON.parse(decodeURIComponent(script.getAttribute('data-tervyn'))); } catch (e) { /* defaults */ }
  window.__tervyn = cfg;

  var P = '/p/';
  var SKIP = /^(data|blob|javascript|mailto|tel|about|chrome|intent|sms|geo|magnet|ws|wss):/i;

  function decode(pathname, search, hash) {
    var m = pathname.match(/^\/p\/(https?)\/([^/?#]+)(\/.*)?$/i);
    if (!m) return null;
    try { return new URL(m[1] + '://' + m[2] + (m[3] || '/') + (search || '') + (hash || '')); } catch (e) { return null; }
  }
  // The site we're showing right now (follows pushState).
  function current() {
    return decode(location.pathname, location.search, location.hash) || (cfg.u ? new URL(cfg.u) : null);
  }
  function encode(u) {
    return P + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
  }
  function toProxy(raw) {
    if (raw == null) return raw;
    var s = String(raw).trim();
    if (!s || s.charAt(0) === '#' || SKIP.test(s) || s.indexOf(P) === 0) return raw;
    var base = current();
    if (!base) return raw;
    var u;
    try {
      // Absolute URLs that point at the gateway itself but outside /p/ belong to the site.
      u = new URL(s, base);
      if (u.origin === location.origin) {
        if (u.pathname.indexOf(P) === 0) return u.pathname + u.search + u.hash;
        u = new URL(u.pathname + u.search + u.hash, base);
      }
    } catch (e) { return raw; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    return encode(u);
  }
  window.__tervynProxy = toProxy;

  // ---------- service worker: catches every request the page makes ----------
  var swc = navigator.serviceWorker;
  if (swc && window.isSecureContext) {
    var realRegister = swc.register.bind(swc);
    var realGetRegs = swc.getRegistrations.bind(swc);
    if (window === window.top) realRegister('/sw.js', { scope: '/' }).catch(function () {});
    // A site's own worker would replace ours on this shared origin.
    try {
      var proto = Object.getPrototypeOf(swc);
      Object.defineProperty(proto, 'register', { configurable: true, value: function () {
        return Promise.reject(new DOMException('Service workers are turned off for sites opened through Tervyn.', 'SecurityError'));
      } });
      Object.defineProperty(proto, 'getRegistrations', { configurable: true, value: function () {
        return realGetRegs().then(function () { return []; });
      } });
      Object.defineProperty(proto, 'getRegistration', { configurable: true, value: function () { return Promise.resolve(undefined); } });
    } catch (e) { /* not patchable */ }
  }

  // ---------- requests made by page scripts ----------
  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) input = toProxy(String(input));
        else if (input && input.url) {
          var fixed = toProxy(input.url);
          if (fixed !== input.url) input = new Request(fixed, input);
        }
      } catch (e) { /* send as is */ }
      return realFetch.call(this, input, init);
    };
  }
  var realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = toProxy(String(url)); } catch (e) { /* as is */ }
    return realOpen.apply(this, args);
  };
  if (navigator.sendBeacon) {
    var realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { return realBeacon(toProxy(String(url)), data); };
  }
  // WebSockets: wss://site/path -> wss://gateway/p/https/site/path
  var RealWS = window.WebSocket;
  if (RealWS) {
    var WS = function (url, protocols) {
      var target = url;
      try {
        var base = current();
        var u = new URL(String(url), base || location.href);
        if (u.host === location.host && u.pathname.indexOf(P) !== 0 && base) u = new URL(u.pathname + u.search, base);
        if (u.pathname.indexOf(P) !== 0 || u.host !== location.host) {
          var scheme = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https' : 'http';
          target = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + P + scheme + '/' + u.host + u.pathname + u.search;
        }
      } catch (e) { /* use as is */ }
      return protocols === undefined ? new RealWS(target) : new RealWS(target, protocols);
    };
    WS.prototype = RealWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { WS[k] = RealWS[k]; });
    window.WebSocket = WS;
  }
  var realWinOpen = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (url) args[0] = toProxy(String(url));
    return realWinOpen.apply(window, args);
  };
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function (state, title, url) {
      if (url != null && url !== '') url = toProxy(String(url));
      return orig.call(history, state, title, url);
    };
  });

  // ---------- links and forms created by scripts ----------
  var ATTRS = { A: 'href', AREA: 'href', FORM: 'action', IMG: 'src', SCRIPT: 'src', IFRAME: 'src', SOURCE: 'src', VIDEO: 'src', AUDIO: 'src', LINK: 'href', EMBED: 'src', TRACK: 'src', INPUT: 'src' };
  function fixEl(el) {
    var attr = el && el.tagName && ATTRS[el.tagName];
    if (!attr) return;
    var raw = el.getAttribute(attr);
    if (raw == null) return;
    var fixed = toProxy(raw);
    if (fixed !== raw) el.setAttribute(attr, fixed);
    if (el.hasAttribute('integrity')) el.removeAttribute('integrity');
    if (el.hasAttribute('srcset')) {
      el.setAttribute('srcset', el.getAttribute('srcset').split(',').map(function (part) {
        var m = part.trim().match(/^(\S+)(\s+.*)?$/);
        return m ? toProxy(m[1]) + (m[2] || '') : part;
      }).join(', '));
    }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href],area[href]');
    if (a) fixEl(a);
  }, true);
  document.addEventListener('submit', function (e) { fixEl(e.target); }, true);
  // Until the service worker controls this page, rewrite elements as they're added.
  if (!(swc && swc.controller)) {
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.type === 'attributes') { fixEl(r.target); continue; }
        for (var j = 0; j < r.addedNodes.length; j++) {
          var n = r.addedNodes[j];
          if (n.nodeType !== 1) continue;
          fixEl(n);
          if (n.querySelectorAll) n.querySelectorAll('a,img,script,iframe,source,video,audio,link,form').forEach(fixEl);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'action'] });
  }

  // ---------- toolbar ----------
  if (window !== window.top) return;
  function bar() {
    var t = current();
    var host = document.createElement('tervyn-bar');
    var root = host.attachShadow({ mode: 'closed' });
    // Windows has no flag emoji (shows "us"), so flags are only used elsewhere.
    var noFlags = /Windows/.test(navigator.userAgent);
    var flag = function (c) { return !noFlags && /^[A-Z]{2}$/.test(c) ? String.fromCodePoint.apply(null, c.split('').map(function (x) { return 0x1f1e6 + x.charCodeAt(0) - 65; })) + ' ' : ''; };
    var region = /^P\d+$/.test(cfg.x || '') ? 'via server ' + cfg.x.slice(1) : cfg.x ? 'via ' + flag(cfg.x) + cfg.x : (cfg.p || 'gateway');
    root.innerHTML =
      '<style>' +
      ':host{all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483647;font:13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif}' +
      '.pill{display:flex;align-items:center;gap:6px;background:#141a26;color:#eef2ff;border-radius:999px;padding:6px 8px 6px 10px;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:calc(100vw - 24px)}' +
      '.dot{width:8px;height:8px;border-radius:50%;background:#34d399;flex:none}' +
      '.lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw;cursor:pointer}' +
      'form{display:none;gap:6px}.open form{display:flex}.open .lbl{display:none}' +
      'select{all:unset;cursor:pointer;background:#2b3548;color:#eef2ff;border-radius:999px;padding:5px 9px;max-width:9.5em}' +
      'input{all:unset;background:#232b3b;color:#fff;border-radius:999px;padding:5px 10px;width:min(52vw,420px)}' +
      'button,a{all:unset;cursor:pointer;background:#2b3548;color:#eef2ff;border-radius:999px;padding:5px 9px;white-space:nowrap}' +
      'button:hover,a:hover{background:#3a4660}.go{background:#4f7cff}.go:hover{background:#3d68ea}' +
      '.x{background:transparent;padding:5px 6px}' +
      '</style>' +
      '<div class="pill"><span class="dot"></span>' +
      '<span class="lbl" title="Tervyn web proxy"></span>' +
      '<form><input name="u" autocomplete="off" spellcheck="false" aria-label="Address"><button class="go" type="submit">Go</button>' +
      '<select class="cc" aria-label="Country" hidden><option value="">No country (fastest)</option></select>' +
      '<a class="home" href="/__tervyn/home" title="Tervyn home">Home</a><a class="direct" rel="noreferrer" title="Leave the proxy and open this page directly">Direct</a></form>' +
      '<button class="x" type="button" title="Hide toolbar" aria-label="Hide toolbar">✕</button></div>';
    var pill = root.querySelector('.pill');
    var lbl = root.querySelector('.lbl');
    var input = root.querySelector('input');
    lbl.textContent = 'Tervyn · ' + (t ? t.hostname : '') + ' · ' + region;
    if (cfg.h) {
      lbl.textContent = 'Human check on this page. If it keeps failing, use the Tervyn extension';
      lbl.title = 'Complete the check on the page. Some checks (e.g. Cloudflare) only pass when your browser connects to the site directly; the Tervyn VPN extension does that through a proxy.';
    }
    var cc = root.querySelector('.cc');
    var ccLoaded = false;
    function loadCountries() {
      if (ccLoaded) return;
      ccLoaded = true;
      realFetch.call(window, '/__tervyn/exits', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
        var group = function (label, items) {
          if (!items.length) return;
          var g = document.createElement('optgroup'); g.label = label;
          items.forEach(function (it) {
            var o = document.createElement('option');
            o.value = it[0]; o.textContent = it[1];
            if (it[0] === cfg.x) o.selected = true;
            g.appendChild(o);
          });
          cc.appendChild(g);
        };
        group('Webshare servers', (d.servers || []).map(function (sv) { return [sv.id, 'Server ' + sv.id.slice(1) + ' · ' + flag(sv.code) + sv.name]; }));
        group('Free servers by country', (d.countries || []).map(function (c) { return [c.code, flag(c.code) + c.name]; }));
        cc.hidden = !((d.countries || []).length || (d.servers || []).length);
      }).catch(function () { /* this gateway has no countries */ });
    }
    // Switching country reloads this page through a free server in that country.
    cc.onchange = function () { var c = current(); if (c) location.href = '/go?url=' + encodeURIComponent(c.href) + '&exit=' + encodeURIComponent(cc.value); };
    lbl.onclick = function () { pill.classList.add('open'); loadCountries(); var c = current(); input.value = c ? c.href : ''; input.focus(); input.select(); };
    root.querySelector('.direct').onclick = function () { var c = current(); if (c) location.href = c.href; };
    root.querySelector('form').onsubmit = function (e) { e.preventDefault(); if (input.value.trim()) location.href = '/go?url=' + encodeURIComponent(input.value.trim()) + (cc.hidden ? '' : '&exit=' + encodeURIComponent(cc.value)); };
    root.querySelector('.x').onclick = function () {
      if (pill.classList.contains('open')) pill.classList.remove('open'); else host.remove();
    };
    document.documentElement.appendChild(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bar); else bar();
})();
