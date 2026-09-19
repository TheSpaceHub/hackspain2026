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

# Only the agent on this port: live (:7860) and sim (:7861) run as separate processes.
for pid in $(pgrep -f 'tsx src/index.ts'); do
  if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "PORT=$PORT" \
     || { [ "$PORT" = 7860 ] && ! tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q '^PORT='; }; then
    kill "$pid" || true
  fi
done
sleep 2
cd "$(dirname "$0")/.."
# tsx is a node shebang script; a nohup'd shell may not carry the nvm PATH.
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" | tail -1)/bin:$PATH"
fi
exec ./node_modules/.bin/tsx src/index.ts
