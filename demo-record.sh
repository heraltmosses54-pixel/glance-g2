#!/usr/bin/env bash
# Record the Glance demo video in the Even Hub simulator.
# Runs everything under Xvfb, drives the app through the simulator's
# HTTP automation plane, and records the virtual screen with ffmpeg.
#
# Usage: ./demo-record.sh            (writes demo.mp4, ~60-75s)
# Requires: Xvfb, ffmpeg, the built app (npm run build already done).
set -euo pipefail
cd "$(dirname "$0")"

DISPLAY_NUM=99
export DISPLAY=:$DISPLAY_NUM
XVFB_RES=1280x800x24
VIDEO_SIZE=1280x800
SIM_PORT=9898
OUT=demo.mp4

cleanup() {
  echo "--- stopping ---"
  kill $FFMPEG_PID 2>/dev/null || true
  kill $SIM_PID 2>/dev/null || true
  kill $VITE_PID 2>/dev/null || true
  kill $XVFB_PID 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

# 1. Virtual display
Xvfb :$DISPLAY_NUM -screen 0 $XVFB_RES -ac >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 2

# 2. Vite dev server
npm run dev -- --host 127.0.0.1 --port 5173 >/tmp/vite.log 2>&1 &
VITE_PID=$!
sleep 3
curl -s -o /dev/null --max-time 10 http://127.0.0.1:5173/ || { echo "vite did not come up"; exit 1; }

# 3. Simulator with the automation plane
evenhub-simulator http://127.0.0.1:5173 --automation-port $SIM_PORT >/tmp/sim.log 2>&1 &
SIM_PID=$!
for i in $(seq 1 30); do
  curl -s --max-time 2 http://127.0.0.1:$SIM_PORT/api/ping | grep -q pong && break
  sleep 1
done
curl -s --max-time 2 http://127.0.0.1:$SIM_PORT/api/ping | grep -q pong || { echo "simulator did not come up"; exit 1; }

# 4. Wait for the app to log ready, then start recording.
python3 - <<'PY'
import json, time, urllib.request
BASE = "http://127.0.0.1:9898"
deadline = time.time() + 60
since = 0
while time.time() < deadline:
    try:
        with urllib.request.urlopen(f"{BASE}/api/console?since_id={since}", timeout=10) as r:
            data = json.loads(r.read())
        for e in data.get("entries", []):
            since = max(since, e.get("id", since))
            if "[glance] ready" in str(e.get("message", "")):
                print("app ready")
                raise SystemExit(0)
    except SystemExit:
        raise
    except Exception:
        pass
    time.sleep(0.5)
print("app did not signal ready in 60s")
raise SystemExit(1)
PY
sleep 2  # let the first price tick land

# 5. Record the virtual screen.
ffmpeg -y -f x11grab -video_size $VIDEO_SIZE -framerate 30 -i :$DISPLAY_NUM \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 $OUT >/tmp/ffmpeg.log 2>&1 &
FFMPEG_PID=$!
sleep 2

input() { curl -s -X POST http://127.0.0.1:$SIM_PORT/api/input -H 'Content-Type: application/json' -d "{\"action\":\"$1\"}" >/dev/null; }

# Demo script (mirrors README):
#  0:00-0:08  BTC home (live price)
sleep 8
#  0:08  tap -> ETH
input click; sleep 4
#  tap -> SOL
input click; sleep 4
#  tap -> back to BTC
input click; sleep 4
#  scroll down -> actions list
input down; sleep 4
#  click first item -> Buy $25 BTC (paper) -> confirm screen
input click; sleep 4
#  tap again -> confirm the trade, back home with the position
input click; sleep 5
#  scroll down -> actions again, pick "Alert above +5%" (3rd item: down, down, click)
input down; sleep 3
input down; sleep 1
input down; sleep 1
input click; sleep 5
#  hold the final home screen (with position + armed alert)
sleep 8

echo "--- done, stopping ffmpeg ---"
kill $FFMPEG_PID
wait $FFMPEG_PID 2>/dev/null || true
trap - EXIT
cleanup
echo "Wrote $OUT"
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 $OUT
