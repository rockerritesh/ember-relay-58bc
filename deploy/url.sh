#!/usr/bin/env bash
# Print the broker's current public URL. The quick tunnel picks a new hostname
# every time the cloudflared service restarts, so ask rather than remember.
set -euo pipefail
PROJECT="${GCP_CPU_PROJECT:-rnd-sumit-astha}"
ZONE="${GCP_CPU_ZONE:-us-central1-a}"
INSTANCE="${GCP_CPU_INSTANCE:-rnd-sumit-vm}"

gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --tunnel-through-iap \
  --command 'agent-tunnel-url' 2>/dev/null | tr -d '\r'
