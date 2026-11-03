// HTML / CSS / header rewriting so that a proxied page keeps loading through the gateway.
// Pure string functions: they run the same on Cloudflare, Deno, Vercel, Netlify and Node.

import { toProxy, encodeTarget, PREFIX } from './url.js';

const URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'poster', 'background', 'cite', 'data', 'longdesc',
  'xlink:href', 'data-src', 'data-href', 'data-url', 'data-original', 'data-lazy-src', 'manifest', 'ping',
]);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset', 'data-srcset']);
const DROP_ATTRS = new Set(['integrity']); // the bytes change (CSS rewriting), so hashes would fail

// ---------- CSS ----------

export function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => `url(${q}${toProxy(u, base)}${q})`)
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => `@import ${q}${toProxy(u, base)}${q}`);
}

function rewriteSrcset(value, base) {
  return value.split(',').map((part) => {
    const m = part.trim().match(/^(\S+)(\s+.*)?$/);
    return m ? toProxy(m[1], base) + (m[2] || '') : part;
  }).join(', ');
}

// ---------- HTML ----------

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&#x2f;|&#47;/gi, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const encodeAttr = (s, q) => s.replace(/&/g, '&amp;').replace(q === "'" ? /'/g : /"/g, q === "'" ? '&#39;' : '&quot;');

const ATTR_RE = /([^\s"'<>/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// Rewrites the attributes of one start tag. Returns the new tag text.
function rewriteTag(tag, name, attrText, close, ctx) {
  const lower = name.toLowerCase();
  let attrs = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrText))) {
    attrs.push({ name: m[1], eq: m[2], value: m[3] ?? m[4] ?? m[5], quote: m[3] != null ? '"' : m[4] != null ? "'" : '' });
  }
  const get = (n) => attrs.find((a) => a.name.toLowerCase() === n);

  if (lower === 'meta') {
    const equiv = (get('http-equiv')?.value || '').toLowerCase();
    const metaName = (get('name')?.value || '').toLowerCase();
    if (equiv === 'content-security-policy' || equiv === 'x-frame-options' || metaName === 'referrer') return '';
    if (equiv === 'refresh') {
      const c = get('content');
      if (c?.value) {
        c.value = decodeEntities(c.value).replace(/(url\s*=\s*['"]?)([^'";]+)/i, (x, p, u) => p + toProxy(u, ctx.base));
        c.changed = true;
      }
    }
  }
  if (lower === 'base') {
    const h = get('href');
    if (h?.value) { try { ctx.base = new URL(decodeEntities(h.value), ctx.base).href; } catch { /* keep */ } }
  }

  let changed = false;
  attrs = attrs.filter((a) => {
    const n = a.name.toLowerCase();
    if (DROP_ATTRS.has(n)) { changed = true; return false; }
    if (lower === 'script' && n === 'nonce') return true;
    if (a.value == null) return true;
    if (a.changed) { changed = true; return true; }
    let v = a.value;
    if (URL_ATTRS.has(n)) v = toProxy(decodeEntities(v), ctx.base);
    else if (SRCSET_ATTRS.has(n)) v = rewriteSrcset(decodeEntities(v), ctx.base);
    else if (n === 'style' && /url\(/i.test(v)) v = rewriteCss(decodeEntities(v), ctx.base);
    else return true;
    if (v !== a.value) { a.value = v; a.changed = true; changed = true; }
    return true;
  });
  if (!changed) return tag;

  const out = attrs.map((a) => {
    if (a.value == null) return a.name;
    if (!a.changed) return `${a.name}${a.eq}${a.quote}${a.value}${a.quote}`;
    const q = a.quote || '"';
    return `${a.name}=${q}${encodeAttr(a.value, q)}${q}`;
  });
  return `<${name}${out.length ? ' ' + out.join(' ') : ''}${close}>`;
}

// Script/style/textarea bodies, comments and tags, in document order.
const TOKEN_RE = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<([a-zA-Z][\w:-]*)(\s[^>]*?)?(\/?)>/gi;

export function rewriteHtml(html, base, { inject = '' } = {}) {
  const ctx = { base };
  let injected = !inject;
  const out = html.replace(TOKEN_RE, (all, rawName, rawAttrs, body, name, attrs, close) => {
    if (all.startsWith('<!--')) return all;
    if (rawName) {
      const lower = rawName.toLowerCase();
      const openTag = rewriteTag(`<${rawName}${rawAttrs}>`, rawName, rawAttrs || '', '', ctx);
      const content = lower === 'style' ? rewriteCss(body, ctx.base) : body;
      return `${openTag}${content}</${rawName}>`;
    }
    const tag = rewriteTag(all, name, attrs || '', close, ctx);
    if (!injected && /^head$/i.test(name)) { injected = true; return tag + inject; }
    return tag;
  });
  if (injected) return out;
  // No <head>: put the script right after <html ...> or at the very top.
  const htmlTag = out.match(/<html\b[^>]*>/i);
  if (htmlTag) return out.replace(htmlTag[0], htmlTag[0] + inject);
  return inject + out;
}

// ---------- headers ----------

// Scope a site's cookies to its own /p/<scheme>/<host>/ path, so sites behind
// one gateway can't read each other's cookies.
export function rewriteSetCookie(cookie, target) {
  const scope = `${PREFIX}${target.protocol.slice(0, -1)}/${target.host}`;
  const parts = cookie.split(';');
  const kept = [parts[0]];
  let path = '/';
  for (const p of parts.slice(1)) {
    const [k, ...v] = p.split('=');
    const key = k.trim().toLowerCase();
    if (key === 'domain') continue;
    if (key === 'path') { path = v.join('=').trim() || '/'; continue; }
    if (key === 'samesite' && /none/i.test(v.join('='))) { kept.push(' SameSite=Lax'); continue; }
    kept.push(p);
  }
  // __Host- cookies may not have a path other than "/": drop the prefix so the browser keeps them.
  kept[0] = kept[0].replace(/^\s*__Host-/, '__Host_');
  kept.push(` Path=${scope}${path.startsWith('/') ? path : '/' + path}`);
  return kept.join(';');
}

export function rewriteLocation(location, target) {
  try { return encodeTarget(new URL(location, target)); } catch { return location; }
}

// Link: </style.css>; rel=preload  -> proxied
export function rewriteLinkHeader(value, target) {
  return value.replace(/<([^>]*)>/g, (m, u) => `<${toProxy(u, target)}>`);
}
