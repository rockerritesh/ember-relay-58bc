#!/usr/bin/env bash
# Ship the broker to rnd-sumit-vm and (re)start it. Idempotent — re-run to upgrade.
#
# Only server/ and shared/ travel: the broker has no dependencies, so there is
# no node_modules and no npm install on the far side. The MCP server stays on
# the agent machines, which are the only places that need the SDK.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${GCP_CPU_PROJECT:-rnd-sumit-astha}"
ZONE="${GCP_CPU_ZONE:-us-central1-a}"
INSTANCE="${GCP_CPU_INSTANCE:-rnd-sumit-vm}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.agent-tunnel/broker-token}"

ssh_vm() { gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --tunnel-through-iap --command "$1"; }

if [ ! -f "$TOKEN_FILE" ]; then
  echo "No token at $TOKEN_FILE — generating one."
  mkdir -p "$(dirname "$TOKEN_FILE")"
  (umask 077; openssl rand -hex 32 > "$TOKEN_FILE")
fi
TOKEN="$(cat "$TOKEN_FILE")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar czf "$STAGE/app.tgz" server shared package.json README.md

echo "==> uploading to $INSTANCE"
gcloud compute scp --tunnel-through-iap --zone "$ZONE" --project "$PROJECT" \
  "$STAGE/app.tgz" deploy/install.sh "$INSTANCE:/tmp/"

echo "==> installing"
ssh_vm "set -e
  rm -rf /tmp/agent-tunnel-stage && mkdir -p /tmp/agent-tunnel-stage
  tar xzf /tmp/app.tgz -C /tmp/agent-tunnel-stage
  command -v rsync >/dev/null || sudo apt-get install -y rsync >/dev/null
  BROKER_TOKEN='$TOKEN' bash /tmp/install.sh"
