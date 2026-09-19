#!/usr/bin/env bash
# Restart the call server without cutting anyone off.
#
# /health reports how many calls are on the line right now. We wait for that to reach
# zero before sending SIGTERM, because a restart mid-call is a caller hung up on. Any
# call that starts while we are waiting extends the wait; use a maintenance window if
# that never settles.
set -euo pipefail

PORT="${PORT:-7860}"
HEALTH="${HEALTH:-http://127.0.0.1:$PORT/health}"
DEADLINE=$(( $(date +%s) + ${MAX_WAIT:-600} ))

while :; do
  live=$(curl -sf --max-time 5 "$HEALTH" | sed -n 's/.*"live": *\([0-9]*\).*/\1/p' || echo '')
  [ -z "$live" ] && { echo "[restart] server not answering, nothing to drain"; break; }
  [ "$live" = "0" ] && { echo "[restart] idle, restarting"; break; }
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "[restart] $live call(s) still up after the wait — refusing to cut them off" >&2
    exit 1
  fi
  echo "[restart] $live call(s) on the line, waiting…"
  sleep 5
done

pkill -f 'tsx src/index.ts' || true
sleep 2
cd "$(dirname "$0")/.."
exec ./node_modules/.bin/tsx src/index.ts
