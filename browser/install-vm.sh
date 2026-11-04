#!/usr/bin/env bash
# Tervyn Browser on a free always-on Linux VM (Oracle Cloud "Always Free" Ubuntu: 4 cores,
# 24 GB memory; also any Ubuntu/Debian server). No session limits, runs 24/7, restarts by
# itself. Needs no open ports: a free Cloudflare quick tunnel gives it an https address.
#
#   curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/tervyn/claude/beautiful-cannon-rasmat/browser/install-vm.sh | sudo bash
#
# Then put your Webshare .txt files in /etc/tervyn/proxies/ and run it again (or:
#   sudo systemctl restart tervyn-browser).
set -euo pipefail
REPO=${REPO:-https://github.com/Fadi-yt1/tervyn}
BRANCH=${BRANCH:-claude/beautiful-cannon-rasmat}
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

echo "== Installing Docker, git, cloudflared"
apt-get update -qq
apt-get install -y -qq docker.io git curl ca-certificates >/dev/null
systemctl enable --now docker >/dev/null
arch=$(dpkg --print-architecture)   # amd64 or arm64 (Oracle Ampere)
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch.deb"
  dpkg -i /tmp/cloudflared.deb >/dev/null
fi

echo "== Getting Tervyn"
if [ -d /opt/tervyn/.git ]; then git -C /opt/tervyn fetch -q origin "$BRANCH" && git -C /opt/tervyn checkout -q -B "$BRANCH" "origin/$BRANCH"
else git clone -q --depth 1 -b "$BRANCH" "$REPO" /opt/tervyn; fi

mkdir -p /etc/tervyn/proxies
chmod 700 /etc/tervyn
[ -s /etc/tervyn/access-key ] || head -c 18 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > /etc/tervyn/access-key
chmod 600 /etc/tervyn/access-key

# Start script used by systemd: rebuilds nothing, reads your proxies fresh each start.
cat > /usr/local/bin/tervyn-browser-run <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
PROXIES=$(cat /etc/tervyn/proxies/*.txt 2>/dev/null | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | tr '\r\n' '  ' || true)
docker rm -f tervyn-browser >/dev/null 2>&1 || true
exec docker run --rm --name tervyn-browser -p 127.0.0.1:8090:8090 --shm-size=1g \
  -e ACCESS_KEY="$(cat /etc/tervyn/access-key)" -e PRIVATE_PROXIES="$PROXIES" -e IDLE_MINUTES=0 \
  tervyn-browser
RUN
chmod 755 /usr/local/bin/tervyn-browser-run

echo "== Building the browser image (a few minutes the first time)"
docker build -q -f /opt/tervyn/browser/Dockerfile -t tervyn-browser /opt/tervyn >/dev/null

cat > /etc/systemd/system/tervyn-browser.service <<'UNIT'
[Unit]
Description=Tervyn Browser (real Chrome streamed to a web page)
After=docker.service
Requires=docker.service
[Service]
ExecStart=/usr/local/bin/tervyn-browser-run
ExecStop=/usr/bin/docker stop tervyn-browser
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/tervyn-tunnel.service <<'UNIT'
[Unit]
Description=Free Cloudflare quick tunnel for the Tervyn Browser
After=network-online.target tervyn-browser.service
Wants=network-online.target
[Service]
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --url http://localhost:8090
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q tervyn-browser tervyn-tunnel
systemctl restart tervyn-browser tervyn-tunnel

echo "== Waiting for the https address"
URL=""
for _ in $(seq 1 60); do
  URL=$(journalctl -u tervyn-tunnel --since "-5 min" --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$URL" ] && break; sleep 2
done
echo
echo "  Tervyn Browser is running (always on; restarts by itself)"
echo "  Open:  ${URL:-run: journalctl -u tervyn-tunnel | grep trycloudflare}"
echo "  Key:   $(cat /etc/tervyn/access-key)"
echo "  Your proxies: put Webshare .txt files in /etc/tervyn/proxies/, then: sudo systemctl restart tervyn-browser"
echo "  The quick-tunnel address changes when the VM restarts. See it again with:"
echo "    journalctl -u tervyn-tunnel | grep -o 'https://.*trycloudflare.com' | tail -1"
