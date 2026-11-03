// Streaming HTML rewriting with Cloudflare's native HTMLRewriter.
// Same result as rewriteHtml() in rewrite.js, but the page streams through
// without being buffered, and the parsing runs in native code. That keeps
// big pages well under the Workers free plan's 10 ms CPU limit.
import { toProxy } from './url.js';
import { rewriteCss } from './rewrite.js';

const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'background', 'cite', 'data', 'longdesc',
  'data-src', 'data-href', 'data-url', 'data-original', 'data-lazy-src', 'manifest', 'ping'];
const SRCSET_ATTRS = ['srcset', 'imagesrcset', 'data-srcset'];

const srcset = (v, base) => v.split(',').map((part) => {
  const m = part.trim().match(/^(\S+)(\s+.*)?$/);
  return m ? toProxy(m[1], base) + (m[2] || '') : part;
}).join(', ');

// Returns true if this content type can go through HTMLRewriter (UTF-8 or no charset given).
export function canStream(type) {
  const cs = (type.match(/charset=["']?([\w-]+)/i) || [])[1];
  return !cs || /^utf-?8$/i.test(cs);
}

export function streamHtml(HTMLRewriter, response, base, inject) {
  const ctx = { base, injected: false };
  let rw = new HTMLRewriter()
    .on('base[href]', { element(el) { try { ctx.base = new URL(el.getAttribute('href'), ctx.base).href; } catch { /* keep */ } } })
    .on('meta', {
      element(el) {
        const equiv = (el.getAttribute('http-equiv') || '').toLowerCase();
        const name = (el.getAttribute('name') || '').toLowerCase();
        if (equiv === 'content-security-policy' || equiv === 'x-frame-options' || name === 'referrer') { el.remove(); return; }
        if (equiv === 'refresh') {
          const c = el.getAttribute('content');
          if (c) el.setAttribute('content', c.replace(/(url\s*=\s*['"]?)([^'";]+)/i, (x, p, u) => p + toProxy(u, ctx.base)));
        }
      },
    })
    .on('[integrity]', { element(el) { el.removeAttribute('integrity'); } })
    .on('[style]', {
      element(el) {
        const v = el.getAttribute('style');
        if (/url\(/i.test(v)) el.setAttribute('style', rewriteCss(v, ctx.base));
      },
    })
    .on('head, body', {
      element(el) {
        if (ctx.injected) return;
        ctx.injected = true;
        el.prepend(inject, { html: true });
      },
    })
    .on('style', (() => {
      let buf = '';
      return {
        text(chunk) {
          buf += chunk.text;
          if (chunk.lastInTextNode) { chunk.replace(rewriteCss(buf, ctx.base), { html: true }); buf = ''; }
          else chunk.remove();
        },
      };
    })());
  for (const attr of URL_ATTRS) {
    rw = rw.on(`[${attr}]`, {
      element(el) {
        const v = el.getAttribute(attr);
        const fixed = toProxy(v, ctx.base);
        if (fixed !== v) el.setAttribute(attr, fixed);
      },
    });
  }
  for (const attr of SRCSET_ATTRS) {
    rw = rw.on(`[${attr}]`, { element(el) { el.setAttribute(attr, srcset(el.getAttribute(attr), ctx.base)); } });
  }
  rw = rw.onDocument({ end(end) { if (!ctx.injected) end.append(inject, { html: true }); } });
  return rw.transform(response);
}
