#!/usr/bin/env bash
# Start the broker on localhost. The tunnel is what makes it reachable;
# the broker itself never binds a public interface.
set -euo pipefail
cd "$(dirname "$0")/.."

export PORT="${PORT:-8787}"
export HOST="${HOST:-127.0.0.1}"
export DATA_DIR="${DATA_DIR:-$PWD/data}"

exec node server/broker.mjs
