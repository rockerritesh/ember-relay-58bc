#!/usr/bin/env bash
# Open a Cloudflare quick tunnel to the local broker and print the public URL.
# The URL is ephemeral: it changes every time this script restarts, which is
# the only thing standing between the broker and the internet until a token
# is configured. Treat it as a secret.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install it with:  brew install cloudflared" >&2
  exit 1
fi

if ! curl -sf "http://127.0.0.1:${PORT}/v1/health" >/dev/null; then
  echo "No broker responding on http://127.0.0.1:${PORT} — start it first:  npm run broker" >&2
  exit 1
fi

LOG="$(mktemp -t agent-tunnel-cloudflared)"
echo "starting tunnel to http://127.0.0.1:${PORT} ..." >&2
cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "${URL:-}" ]; then
  echo "tunnel did not report a URL within 60s; cloudflared log:" >&2
  cat "$LOG" >&2
  exit 1
fi

echo "$URL" > .tunnel-url
echo
echo "  public broker URL:  $URL"
echo "  health check:       curl $URL/v1/health"
echo "  saved to:           $PWD/.tunnel-url"
echo
echo "Give that URL to the remote agent as BROKER_URL. Ctrl-C to close the tunnel."
wait "$PID"
