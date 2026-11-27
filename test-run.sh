#!/usr/bin/env bash
# Full simulator smoke test: Xvfb + Vite + simulator + sim-test.py.
# Usage: ./test-run.sh   (exit code = test result)
set -u
cd "$(dirname "$0")"

DISPLAY_NUM=99
export DISPLAY=:$DISPLAY_NUM
XVFB_RES=1280x800x24
SIM_PORT=9898
PIDS=""

cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in $PIDS; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

Xvfb :$DISPLAY_NUM -screen 0 $XVFB_RES -ac >/tmp/xvfb.log 2>&1 &
PIDS="$PIDS $!"
sleep 2

npm run dev -- --host 127.0.0.1 --port 5173 >/tmp/vite.log 2>&1 &
PIDS="$PIDS $!"
sleep 3
curl -s --max-time 10 http://127.0.0.1:5173/ >/dev/null || { echo "vite did not come up"; cat /tmp/vite.log | tail -5; exit 1; }

evenhub-simulator http://127.0.0.1:5173 --automation-port $SIM_PORT >/tmp/sim.log 2>&1 &
PIDS="$PIDS $!"
ok=0
for i in $(seq 1 30); do
  curl -s --max-time 2 http://127.0.0.1:$SIM_PORT/api/ping | grep -q pong && { ok=1; break; }
  sleep 1
done
[ "$ok" = 1 ] || { echo "simulator did not come up"; tail -10 /tmp/sim.log; exit 1; }

python3 test/sim-test.py
RC=$?
echo "TEST EXIT: $RC"
echo "--- sim log (last 15) ---"
tail -15 /tmp/sim.log
exit $RC
