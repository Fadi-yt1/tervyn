#!/usr/bin/env bash
# Tervyn Browser on your own computer (macOS / Linux): free, no session limits.
# Starts the browser server and a free Cloudflare quick tunnel, then prints the
# https address and access key to open from any device (phone too).
#   bash browser/run-local.sh
set -euo pipefail
cd "$(dirname "$0")"
PORT=${PORT:-8090}

command -v node >/dev/null || { echo "Please install Node.js 20 or newer from https://nodejs.org, then run this again."; exit 1; }
[ -d node_modules ] || npm ci --omit=dev
npx --yes playwright install chromium >/dev/null

# Access key: made once, kept in browser/.access-key (private).
[ -s .access-key ] || node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))' > .access-key
export ACCESS_KEY="$(tr -d '\r\n' < .access-key)"
# Your proxies: every .txt file in browser/proxies/ (e.g. your Webshare downloads).
export PRIVATE_PROXIES="$(cat proxies/*.txt 2>/dev/null | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | tr '\r\n' '  ' || true)"
export PORT IDLE_MINUTES=${IDLE_MINUTES:-0}

node server.mjs &
SERVER=$!
TUNNEL=""
trap 'kill $SERVER $TUNNEL 2>/dev/null || true' EXIT INT TERM

if [ "${SKIP_TUNNEL:-}" = "1" ]; then
  echo; echo "Tervyn Browser: http://localhost:$PORT   key: $ACCESS_KEY"; wait $SERVER; exit
fi

# Cloudflare quick tunnel: free, no account. Download cloudflared once if needed.
CF=cloudflared
if ! command -v cloudflared >/dev/null; then
  CF=./cloudflared
  if [ ! -x "$CF" ]; then
    arch=$(uname -m); case "$arch" in x86_64|amd64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo "Unsupported CPU: $arch"; exit 1;; esac
    base=https://github.com/cloudflare/cloudflared/releases/latest/download
    if [ "$(uname -s)" = "Darwin" ]; then
      curl -fsSL "$base/cloudflared-darwin-$arch.tgz" | tar -xz -C . cloudflared
    else
      curl -fsSL -o cloudflared "$base/cloudflared-linux-$arch"
    fi
    chmod +x cloudflared
  fi
fi
LOG=$(mktemp)
"$CF" tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL=$!
URL=""
for _ in $(seq 1 60); do URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true); [ -n "$URL" ] && break; sleep 1; done
echo
echo "  ┌──────────────────────────────────────────────────────────────"
echo "  │ Tervyn Browser is running"
echo "  │ Open:  ${URL:-http://localhost:$PORT  (tunnel did not start, see $LOG)}"
echo "  │ Key:   $ACCESS_KEY"
echo "  │ Servers from browser/proxies/: $(printf '%s' "$PRIVATE_PROXIES" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' | sort -u | wc -l | tr -d ' ')"
echo "  │ Keep this window open. Press Ctrl+C to stop."
echo "  └──────────────────────────────────────────────────────────────"
wait $SERVER
