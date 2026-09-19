#!/usr/bin/env bash
# Restart the server, but never while a call is up.
# A call in progress is a person on the phone: killing it is a failed case for them
# and an unexplained hang-up for us. Wait it out, or refuse.
set -uo pipefail

PORT="${PORT:-7860}"
LOG="${1:-/tmp/el-turno-server.log}"
WAIT_MAX="${WAIT_MAX:-240}"

live() {
  curl -sS -m 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("live", 0))' 2>/dev/null || echo 0
}

n=$(live); waited=0
while [ "${n:-0}" -gt 0 ]; do
  if [ "$waited" -ge "$WAIT_MAX" ]; then
    echo "REFUSING: ${n} call(s) still live after ${waited}s. Nothing was killed." >&2
    exit 1
  fi
  echo "waiting — ${n} call(s) live (${waited}s)"
  sleep 5; waited=$((waited + 5)); n=$(live)
done

echo "line clear — restarting"
pkill -f "tsx src/index.ts" 2>/dev/null
sleep 2
while pgrep -f "tsx src/index.ts" >/dev/null; do sleep 1; done

npx tsx src/index.ts > "$LOG" 2>&1 &
for _ in $(seq 1 30); do grep -q "listening on" "$LOG" 2>/dev/null && break; sleep 1; done

echo "processes: $(pgrep -cf 'tsx src/index.ts')"
grep -E "^\[boot\] (llm|listening)" "$LOG"
python3 - <<'PY'
import subprocess, os, time, datetime, glob
pids = subprocess.check_output(['pgrep', '-f', 'tsx src/index.ts']).split()
t_proc = min(datetime.datetime.strptime(
    subprocess.check_output(['ps', '-o', 'lstart=', '-p', p.decode()]).decode().strip(),
    '%a %b %d %H:%M:%S %Y').timestamp() for p in pids)
newest = max(glob.glob('src/**/*.ts', recursive=True), key=os.path.getmtime)
print(f"newest source: {newest} {time.strftime('%H:%M:%S', time.localtime(os.path.getmtime(newest)))}")
print(f"server start : {time.strftime('%H:%M:%S', time.localtime(t_proc))}")
print("VERDICT      :", "LIVE" if t_proc > os.path.getmtime(newest) else "*** STALE ***")
PY
