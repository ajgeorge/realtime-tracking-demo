#!/usr/bin/env bash
# Chaos demo: kill an API node while watching the map.
# Clients it was carrying reconnect through nginx with backoff, land on the
# surviving node, re-watch their drivers, and updates resume.
set -euo pipefail

NODE="${1:-api-1}"

echo "killing ${NODE}…"
docker compose kill "${NODE}"
echo
echo "${NODE} is down. Watch the map: status pills flip to reconnecting,"
echo "then land on the surviving node and updates resume."
echo
echo "bring it back with:  docker compose up -d ${NODE}"
