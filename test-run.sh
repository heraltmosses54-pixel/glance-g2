#!/usr/bin/env bash
# Full simulator smoke test: Xvfb + Vite + simulator + sim-test.py.
# Usage: ./test-run.sh   (exit code = test result)
set -u
cd "$(dirname "$0")"

# Pre-flight: a stale simulator or Vite from an earlier run would
# silently answer on these ports (the ping/curl checks cannot tell a
# stale instance from a fresh one) and the test would then run
# against the OLD app with leftover state. Fail loudly instead.
for p in 5173 9898; do
  if ss -tln 2>/dev/null | grep -q ":$p "; then
    echo "port $p is already in use — kill the stale simulator/Vite first (ps aux | grep -E 'evenhub|Xvfb|vite')"; exit 1
  fi
done

DISPLAY_NUM=99
export DISPLAY=:$DISPLAY_NUM
XVFB_RES=1280x800x24
SIM_PORT=9898
PIDS=""

cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in $PIDS; do kill -9 "$p" 2>/dev/null || true; done
  # npm run dev spawns sh -> node children that outlive the npm PID;
  # kill them by pattern too, or they accumulate and steal the ports.
  pkill -f "evenhub-simulator.*--automation-port $SIM_PORT" 2>/dev/null || true
  pkill -f "Xvfb :$DISPLAY_NUM" 2>/dev/null || true
  pkill -f "vite.*--port 5173" 2>/dev/null || true
}
trap cleanup EXIT

Xvfb :$DISPLAY_NUM -screen 0 $XVFB_RES -ac >/tmp/xvfb.log 2>&1 &
PIDS="$PIDS $!"
sleep 2

npm run dev -- --host 127.0.0.1 --port 5173 >/tmp/vite.log 2>&1 &
PIDS="$PIDS $!"
sleep 3
curl -s --max-time 10 http://127.0.0.1:5173/ >/dev/null || { echo "vite did not come up"; cat /tmp/vite.log | tail -5; exit 1; }

# Fresh state every run: the simulator persists the WebView localStorage
# and bridge storage in its profile dir, so a previous run's position /
# alerts would change what the alerts list shows and break the flow.
# Wiping the profile is safe — the simulator recreates it on launch.
rm -rf "$HOME/.local/share/com.evenrealities.evenhub-simulator"

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
