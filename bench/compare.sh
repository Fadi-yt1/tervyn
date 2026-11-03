#!/usr/bin/env bash
# Time to first byte and total time: direct vs every Tervyn gateway (vs another web proxy).
#
#   bash bench/compare.sh                                  # gateways from gateways.json
#   GATEWAYS="https://a.workers.dev https://b.deno.net" bash bench/compare.sh
#   OTHER='https://other-proxy.example/browse?url={url}' bash bench/compare.sh   # compare with another proxy
#   RUNS=7 SITES=bench/sites.txt bash bench/compare.sh
#
# Prints the median of RUNS runs per cell. Run it from several places (home, phone hotspot, cloud VMs).
set -euo pipefail
cd "$(dirname "$0")/.."
RUNS=${RUNS:-5}
SITES=${SITES:-bench/sites.txt}
if [ -z "${GATEWAYS:-}" ]; then
  GATEWAYS=$(node -e 'console.log((require("./gateways.json").gateways||[]).join(" "))')
fi
[ -n "$GATEWAYS" ] || { echo "No gateways: set GATEWAYS or fill gateways.json"; exit 1; }

median() { sort -n | awk '{a[NR]=$1} END {if (NR==0) {print "-"; exit} m=(NR%2)?a[(NR+1)/2]:(a[NR/2]+a[NR/2+1])/2; printf "%.0f", m*1000}'; }
measure() { # url -> "ttfb_ms total_ms"
  local url=$1 t f
  t=$(mktemp); f=$(mktemp)
  for _ in $(seq "$RUNS"); do
    curl -s -o /dev/null -L --max-time 30 --compressed -A "Mozilla/5.0 (tervyn-bench)" \
      -w "%{time_starttransfer} %{time_total}\n" "$url" 2>/dev/null || echo "30 30"
  done > "$t"
  echo "$(cut -d' ' -f1 "$t" | median) $(cut -d' ' -f2 "$t" | median)"
  rm -f "$t" "$f"
}

printf "%-45s %-28s %10s %10s\n" "site" "route" "TTFB ms" "total ms"
while read -r site; do
  [ -z "$site" ] && continue
  read -r a b <<<"$(measure "$site")"; printf "%-45s %-28s %10s %10s\n" "${site:0:45}" "direct" "$a" "$b"
  for gw in $GATEWAYS; do
    path="/p/$(echo "$site" | sed -E 's#^(https?)://#\1/#')"
    read -r a b <<<"$(measure "$gw$path")"; printf "%-45s %-28s %10s %10s\n" "" "${gw#https://}" "$a" "$b"
  done
  if [ -n "${OTHER:-}" ]; then
    enc=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$site")
    read -r a b <<<"$(measure "${OTHER//\{url\}/$enc}")"; printf "%-45s %-28s %10s %10s\n" "" "other proxy" "$a" "$b"
  fi
done < "$SITES"
