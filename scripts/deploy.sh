#!/usr/bin/env bash
# Deploys the gateway to every free platform that has a token, finds each live URL,
# links all gateways together (gateways.json), redeploys so each one knows the others,
# and smoke-tests them. Used by .github/workflows/deploy.yml; also works locally.
#
# Tokens (any subset; platforms without one are skipped):
#   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID   Cloudflare Workers
#   VERCEL_TOKEN                                   Vercel (project "tervyn" is created on first deploy)
#   NETLIFY_AUTH_TOKEN                             Netlify (site NETLIFY_SITE_NAME is created on first deploy)
# Optional:
#   NETLIFY_SITE_NAME   default: tervyn-<github owner>
#   EXTRA_GATEWAYS      more gateway URLs (Deno Deploy, Render, your VMs), space or comma separated
set -uo pipefail
cd "$(dirname "$0")/.."

WRANGLER="npx --yes wrangler@4.157.0"
VERCEL="npx --yes vercel@65.10.0"
NETLIFY="npx --yes netlify-cli@27.16.2"
OWNER=$(echo "${GITHUB_REPOSITORY_OWNER:-tervyn}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-')
NETLIFY_SITE_NAME=${NETLIFY_SITE_NAME:-tervyn-$OWNER}

# Tokens pasted into the secrets page often carry spaces, newlines, quotes or a
# "NAME: " / "NAME=" prefix. Keep only the token itself.
clean() { printf '%s' "$1" | sed -E 's/^[[:space:]]*[A-Z_]+[[:space:]]*[:=][[:space:]]*//' | tr -d '[:space:]"'"'"; }
CLOUDFLARE_API_TOKEN=$(clean "${CLOUDFLARE_API_TOKEN:-}"); export CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID=$(clean "${CLOUDFLARE_ACCOUNT_ID:-}"); [ -n "$CLOUDFLARE_ACCOUNT_ID" ] && export CLOUDFLARE_ACCOUNT_ID || unset CLOUDFLARE_ACCOUNT_ID
VERCEL_TOKEN=$(clean "${VERCEL_TOKEN:-}")
NETLIFY_AUTH_TOKEN=$(clean "${NETLIFY_AUTH_TOKEN:-}"); export NETLIFY_AUTH_TOKEN
for t in CLOUDFLARE_API_TOKEN VERCEL_TOKEN NETLIFY_AUTH_TOKEN; do
  v=${!t}; [ -n "$v" ] && echo "$t: ${#v} characters, starts with ${v:0:5}"
done
FOUND=()
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/stdout}
log() { echo "::group::$*" 2>/dev/null || echo "== $*"; }
end() { echo "::endgroup::" 2>/dev/null || true; }

cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' "$@"; }

deploy_cloudflare() {
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || return 0
  log "Cloudflare Workers"
  local out url sub name api=https://api.cloudflare.com/client/v4
  if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    CLOUDFLARE_ACCOUNT_ID=$(cf "$api/accounts" | jq -r '.result[0].id // empty'); export CLOUDFLARE_ACCOUNT_ID
  fi
  echo "account: ${CLOUDFLARE_ACCOUNT_ID:-unknown}"
  # Every account needs a workers.dev subdomain once; register one if missing.
  sub=$(cf "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | jq -r '.result.subdomain // empty')
  if [ -z "$sub" ]; then
    for name in "tervyn-$OWNER" "tervyn-$OWNER-$((RANDOM % 9000 + 1000))" "tervyn-$((RANDOM * RANDOM))"; do
      r=$(cf -X PUT "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" -d "{\"subdomain\":\"$name\"}")
      if [ "$(echo "$r" | jq -r '.success')" = "true" ]; then sub=$name; echo "registered $sub.workers.dev"; break; fi
      echo "subdomain $name: $(echo "$r" | jq -c '.errors')"
    done
  fi
  echo "workers.dev subdomain: ${sub:-none}"
  out=$($WRANGLER deploy 2>&1); echo "$out"
  url=$(echo "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
  end
  [ -n "$url" ] && FOUND+=("$url") || echo "::warning::Cloudflare deploy gave no workers.dev URL (open the Workers dashboard once to pick a workers.dev subdomain)"
}

deploy_vercel() {
  [ -n "${VERCEL_TOKEN:-}" ] || return 0
  log "Vercel"
  local dep host alias
  local out
  # Deploy only what Vercel needs, so it doesn't mistake the Dockerfile/render.yaml for a container app.
  local stage; stage=$(mktemp -d)/tervyn
  mkdir -p "$stage/platforms"
  cp -r api gateway scripts vercel.json package.json gateways.json "$stage/"
  cp -r platforms/static platforms/node "$stage/platforms/"
  # Your own proxies (PRIVATE_PROXIES secret) go to Vercel as a private runtime variable,
  # never into the repo. New lines become spaces.
  local envargs=()
  if [ -n "${PRIVATE_PROXIES:-}" ]; then
    envargs=(-e "PRIVATE_PROXIES=$(printf '%s' "$PRIVATE_PROXIES" | tr '\r\n' '  ' | tr -s ' ')")
    echo "private proxies: $(printf '%s' "$PRIVATE_PROXIES" | grep -cE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+') entries"
  fi
  out=$(cd "$stage" && $VERCEL deploy --prod --yes --token "$VERCEL_TOKEN" "${envargs[@]}" 2>&1); echo "$out" | tail -25
  dep=$(echo "$out" | grep -oE 'https://[^ ]+\.vercel\.app' | tail -1)
  echo "deployment: $dep"
  if [ -n "$dep" ]; then
    host=${dep#https://}
    # The stable production domain (deployment URLs can sit behind Vercel's login protection).
    alias=$(curl -fsS -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v13/deployments/$host" 2>/dev/null \
      | jq -r '[.alias[]? | select(endswith(".vercel.app"))] | min_by(length) // empty' 2>/dev/null)
    FOUND+=("https://${alias:-$host}")
    echo "production: https://${alias:-$host}"
  else
    echo "::warning::Vercel deploy failed"
  fi
  end
}

deploy_netlify() {
  [ -n "${NETLIFY_AUTH_TOKEN:-}" ] || return 0
  log "Netlify"
  local api=https://api.netlify.com/api/v1 id url
  echo "token check: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" "$api/user")"
  id=$(curl -fsS -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" "$api/sites?name=$NETLIFY_SITE_NAME&filter=all&per_page=100" \
    | jq -r --arg n "$NETLIFY_SITE_NAME" '[.[] | select(.name == $n)][0].id // empty')
  if [ -z "$id" ]; then
    local slug r
    slug=$(curl -fsS -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" "$api/accounts" | jq -r '.[0].slug // empty')
    echo "creating site $NETLIFY_SITE_NAME in team ${slug:-?}"
    for path in "$slug/sites" "sites"; do
      [ "$path" = "/sites" ] && continue
      r=$(curl -sS -X POST -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" -H 'content-type: application/json' \
        -d "{\"name\":\"$NETLIFY_SITE_NAME\"}" "$api/$path")
      id=$(echo "$r" | jq -r '.id // empty' 2>/dev/null)
      [ -n "$id" ] && break
      echo "POST $path: $(echo "$r" | head -c 300)"
    done
  fi
  if [ -z "$id" ]; then echo "::warning::Could not find or create Netlify site $NETLIFY_SITE_NAME (name taken? set NETLIFY_SITE_NAME)"; end; return 0; fi
  # New Netlify sites can come with "team login" visitor protection; a public proxy needs it off.
  local prot
  prot=$(curl -sS -X PATCH -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" -H 'content-type: application/json' \
    -d '{"sso_login":false,"sso_login_context":"none","password":null,"password_context":"none"}' "$api/sites/$id" \
    | jq -c '{sso_login, sso_login_context, has_password: (.has_password // null)}' 2>/dev/null)
  echo "visitor protection after update: $prot"
  local out
  out=$($NETLIFY deploy --prod --site "$id" --auth "$NETLIFY_AUTH_TOKEN" --json 2>&1)
  url=$(echo "$out" | sed -n '/^{/,$p' | jq -r '.url // empty' 2>/dev/null)
  [ -n "$url" ] || echo "$out" | tail -25
  [ -n "$url" ] && FOUND+=("$url") || echo "::warning::Netlify deploy failed"
  echo "url: $url"
  end
}

deploy_all() { deploy_cloudflare; deploy_vercel; deploy_netlify; }

# ---- pass 1: deploy and discover URLs ----
deploy_all

# ---- link everything: gateways.json = old list + found + extra ----
EXTRA=$(echo "${EXTRA_GATEWAYS:-}" | tr ',' ' ')
node -e '
  const fs = require("fs");
  const file = "gateways.json";
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const add = process.argv.slice(1).map((u) => u.trim().replace(/\/+$/, "")).filter((u) => /^https:\/\//.test(u));
  data.gateways = [...new Set([...(data.gateways || []), ...add])];
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log("gateways:", data.gateways.join(" ") || "(none)");
' "${FOUND[@]}" $EXTRA
node scripts/build-assets.mjs

# ---- pass 2: redeploy if the list changed, so every gateway lists every other ----
if ! git diff --quiet -- gateway/assets.js 2>/dev/null; then
  FOUND=()
  deploy_all
fi

# ---- smoke test every gateway ----
echo "## Tervyn gateways" >> "$SUMMARY"
echo "| Gateway | Ping | Proxy test |" >> "$SUMMARY"
echo "|---|---|---|" >> "$SUMMARY"
OK=0
PASSED=()
for gw in $(node -e 'console.log(require("./gateways.json").gateways.join(" "))'); do
  for try in 1 2 3 4 5 6 7 8; do
    ping=$(curl -fsS -m 20 "$gw/__tervyn/ping" | jq -r '.platform // "?"' 2>/dev/null || echo "down")
    code=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$gw/p/https/example.com/")
    [ "$code" = "200" ] && break
    echo "$gw: attempt $try got HTTP $code, retrying in 20s"; sleep 20
  done
  echo "| $gw | ${ping:-down} | HTTP $code |" >> "$SUMMARY"
  [ "$code" = "200" ] && { OK=$((OK + 1)); PASSED+=("$gw"); }
done
echo "$OK gateway(s) passed the proxy test" | tee -a "$SUMMARY"

# Countries (free proxies): informational, since free servers come and go.
for gw in "${PASSED[@]}"; do
  cc=$(curl -fsS -m 20 "$gw/__tervyn/exits" | jq -r '[.countries[] | select(.code == "US" or .code == "CA")][0].code // .countries[0].code // empty' 2>/dev/null)
  [ -n "$cc" ] || continue
  code=$(curl -s -m 40 -o /dev/null -w '%{http_code}' -H "cookie: tervyn_exit=$cc" "$gw/p/https/example.com/")
  echo "Country check: $gw via $cc free server -> HTTP $code" | tee -a "$SUMMARY"
done

# Publish only gateways that work right now (plus EXTRA_GATEWAYS, which you manage yourself).
if [ "$OK" -gt 0 ]; then
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync("gateways.json", "utf8"));
    const keep = new Set(process.argv.slice(1).map((u) => u.replace(/\/+$/, "")));
    data.gateways = data.gateways.filter((g) => keep.has(g));
    fs.writeFileSync("gateways.json", JSON.stringify(data, null, 2) + "\n");
    console.log("published:", data.gateways.join(" "));
  ' "${PASSED[@]}" $EXTRA
  node scripts/build-assets.mjs
fi
[ "$OK" -gt 0 ] || { echo "::error::No gateway passed the smoke test"; exit 1; }
