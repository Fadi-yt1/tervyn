// Proxy URL scheme and target safety checks.
//
// A proxied URL looks like:  /p/https/example.com/path?q=1
// Keeping the target's path as a real path means relative links ("img/a.png",
// "../b.css") resolve correctly in the browser without any rewriting.

export const PREFIX = '/p/';
const SKIP_SCHEMES = /^(data|blob|javascript|mailto|tel|about|chrome|chrome-extension|moz-extension|intent|sms|geo|magnet|ws|wss):/i;

// "https://example.com/a?b" -> "/p/https/example.com/a?b" (hash kept)
export function encodeTarget(url) {
  const u = url instanceof URL ? url : new URL(url);
  const scheme = u.protocol.slice(0, -1);
  return `${PREFIX}${scheme}/${u.host}${u.pathname}${u.search}${u.hash}`;
}

// "/p/https/example.com/a" + "?b" -> URL("https://example.com/a?b"), or null
export function decodeTarget(pathname, search = '') {
  if (!pathname.startsWith(PREFIX)) return null;
  const m = pathname.slice(PREFIX.length).match(/^(https?)\/([^/?#]+)(\/.*)?$/i);
  if (!m) return null;
  try {
    const u = new URL(`${m[1].toLowerCase()}://${m[2]}${m[3] || '/'}${search}`);
    return u.hostname ? u : null;
  } catch {
    return null;
  }
}

// Turns any link found in a proxied page into a gateway path.
// `base` is the target page URL. Links we can't or shouldn't proxy are returned unchanged.
export function toProxy(raw, base) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s || s.startsWith('#') || SKIP_SCHEMES.test(s) || s.startsWith('\\')) return raw;
  if (s.startsWith(PREFIX)) return raw; // already proxied
  let u;
  try { u = new URL(s, base); } catch { return raw; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
  return encodeTarget(u);
}

// Reads what the user typed: "example.com", "https://x.y/z", "x.y/z?q" or plain words (search).
export function normalizeInput(input, searchUrl = 'https://duckduckgo.com/html/?q=') {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) { try { return new URL(s); } catch { return null; } }
  if (!/\s/.test(s) && /^[^/?#]+\.[a-z]{2,}(?::\d+)?([/?#].*)?$/i.test(s)) {
    try { return new URL(`https://${s}`); } catch { /* fall through to search */ }
  }
  return new URL(searchUrl + encodeURIComponent(s));
}

// ---------- SSRF guard: never let the gateway reach private networks ----------

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/i;
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data']);
const BLOCKED_PORTS = new Set([0, 21, 22, 23, 25, 110, 135, 139, 143, 445, 465, 587, 993, 995, 2375, 2376, 3306, 5432, 6379, 11211, 27017]);

export function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||  // carrier NAT
    (a === 169 && b === 254) ||            // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19));
}

export function isPrivateIPv6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // mapped, hex form: refuse
  return /^(fc|fd|fe[89ab]|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8:');
}

export function isPrivateAddress(ip) {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

// Returns an error message, or '' when the target is allowed.
export function checkTarget(url, { allowPrivate = false } = {}) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https sites can be opened.';
  if (url.username || url.password) return 'Links with a username or password are not allowed.';
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (BLOCKED_PORTS.has(port)) return `Port ${port} is blocked.`;
  if (allowPrivate) return '';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') && !host.includes(':')) return 'Local network names are blocked.';
  if (BLOCKED_HOSTS.has(host) || BLOCKED_NAMES.test(host)) return 'Local network addresses are blocked.';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIPv4(host)) return 'Private IP addresses are blocked.';
  if (host.startsWith('[') && isPrivateIPv6(host)) return 'Private IP addresses are blocked.';
  return '';
}
