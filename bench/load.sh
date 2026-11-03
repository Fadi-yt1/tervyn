#!/usr/bin/env bash
# Throughput / latency under load for one gateway. Uses whichever tool is installed:
# oha (HTTP/2 + HTTP/3 capable), wrk, or autocannon (npx).
#   bash bench/load.sh https://gw.example.com [target-url] [seconds] [connections]
set -euo pipefail
GW=${1:?gateway URL}
TARGET=${2:-https://en.wikipedia.org/static/images/icons/wikipedia.png}
SECS=${3:-30}
CONN=${4:-100}
URL="$GW/p/$(echo "$TARGET" | sed -E 's#^(https?)://#\1/#')"
echo "Load test: $URL  (${SECS}s, $CONN connections)"
if command -v oha >/dev/null; then
  oha -z "${SECS}s" -c "$CONN" --http-version 2 "$URL"
  echo "--- HTTP/3 ---"; oha -z "${SECS}s" -c "$CONN" --http-version 3 "$URL" || echo "(this oha build or gateway has no HTTP/3)"
elif command -v wrk >/dev/null; then
  wrk -t4 -c"$CONN" -d"${SECS}s" --latency "$URL"
else
  npx --yes autocannon@7 -d "$SECS" -c "$CONN" "$URL"
fi
