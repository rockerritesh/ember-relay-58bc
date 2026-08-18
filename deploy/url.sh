#!/usr/bin/env bash
# Print the broker's current public URL. The quick tunnel picks a new hostname
# every time the cloudflared service restarts, so ask rather than remember.
set -euo pipefail
cd "$(dirname "$0")/.."
# Deployment target comes from deploy/target.env (gitignored) or the environment,
# so no host identifiers live in this repo. See deploy/target.env.example.
[ -f deploy/target.env ] && . deploy/target.env
PROJECT="${GCP_PROJECT:?set GCP_PROJECT (see deploy/target.env.example)}"
ZONE="${GCP_ZONE:-us-central1-a}"
INSTANCE="${GCP_INSTANCE:?set GCP_INSTANCE (see deploy/target.env.example)}"

gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --tunnel-through-iap \
  --command 'agent-tunnel-url' 2>/dev/null | tr -d '\r'
