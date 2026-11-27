#!/usr/bin/env python3
"""Headless simulator smoke test for Glance v2.

Assumes the Vite dev server is up on :5173 and the simulator was started as:
  evenhub-simulator http://localhost:5173 --automation-port 9898
under Xvfb. Drives the app through the HTTP control plane, screenshots each
state into ./screenshots/, and asserts the framebuffer is lit through the
v2 flow: watchlist -> 5 coin details -> watchlist -> portfolio -> alerts
list -> actions -> confirm -> buy -> alert arm.

Usage: python3 test/sim-test.py
Exit 0 = all checks pass.
"""
import glob
import io
import json
import os
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:9898"
READY = "[glance] ready"
OUT = "screenshots"

failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def get_json(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=15) as r:
        return json.loads(r.read())


def get_png(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as r:
        return r.read()


def post_json(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def shot(name):
    png = get_png("/api/screenshot/glasses")
    open(f"{OUT}/{name}.png", "wb").write(png)
    return png


def lit_pixels(png_bytes):
    """Count lit pixels in the 576x288 RGBA framebuffer (alpha > 0)."""
    from PIL import Image

    img = Image.open(io.BytesIO(png_bytes))
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    return sum(1 for px in img.getdata() if px[3] > 0)


def composite_views():
    """Composite every raw RGBA framebuffer onto black -> *-view.png."""
    from PIL import Image

    for path in sorted(glob.glob(f"{OUT}/*.png")):
        if path.endswith("-view.png"):
            continue
        img = Image.open(path)
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
        bg.alpha_composite(img)
        bg.convert("RGB").save(path[:-4] + "-view.png")


def wait_ready(timeout=60):
    deadline = time.time() + timeout
    since = 0
    while time.time() < deadline:
        try:
            data = get_json(f"/api/console?since_id={since}")
        except Exception:
            time.sleep(0.5)
            continue
        for e in data.get("entries", []):
            since = max(since, e.get("id", since))
            if READY in str(e.get("message", "")):
                return True
        time.sleep(0.5)
    return False


def click():
    post_json("/api/input", {"action": "click"})
    time.sleep(1.5)


def down():
    post_json("/api/input", {"action": "down"})
    time.sleep(1.0)


def up():
    post_json("/api/input", {"action": "up"})
    time.sleep(1.0)


def main():
    os.makedirs(OUT, exist_ok=True)
    try:
        with urllib.request.urlopen(f"{BASE}/api/ping", timeout=15) as r:
            body = r.read().decode().strip()
        # /api/ping returns plain text "pong", not JSON.
        check("simulator ping", body == "pong", f"got {body!r}")
        if body != "pong":
            return 1
    except Exception as e:
        check("simulator ping", False, str(e))
        return 1

    ready = wait_ready()
    check("app ready marker", ready,
          "found [glance] ready" if ready else "no [glance] ready in console")
    if not ready:
        return 1
    time.sleep(1)

    # 1. Boot = watchlist (5 coins + portfolio + alerts rows).
    boot = shot("1-watchlist")
    check("boot watchlist lit", lit_pixels(boot) > 100, f"{lit_pixels(boot)} lit pixels")

    # 2-6. Tap cycles all five coin details.
    click()
    btc = shot("2-home-btc")
    check("tap opens BTC detail", lit_pixels(btc) > 100)
    click()
    eth = shot("3-home-eth")
    check("tap cycles to ETH detail", lit_pixels(eth) > 100)
    click()
    sol = shot("4-home-sol")
    check("tap cycles to SOL detail", lit_pixels(sol) > 100)
    click()
    xrp = shot("5-home-xrp")
    check("tap cycles to XRP detail", lit_pixels(xrp) > 100)
    click()
    doge = shot("6-home-doge")
    check("tap cycles to DOGE detail", lit_pixels(doge) > 100)
    click()  # wraps back to BTC

    # 7. Scroll up from a coin detail -> watchlist.
    up()
    wl = shot("7-watchlist")
    check("scroll up returns to watchlist", lit_pixels(wl) > 100)

    # 8. Scroll down x5 -> Portfolio row, tap to open it.
    for _ in range(5):
        down()
    click()
    pf = shot("8-portfolio")
    check("portfolio screen opens", lit_pixels(pf) > 100)

    # Tap -> back to watchlist.
    click()
    time.sleep(1.5)

    # 9. Scroll down once (focus 5 -> 6 = Alerts row), tap to open the
    # alerts list.
    down()
    click()
    al = shot("9-alerts-list")
    check("alerts list opens", lit_pixels(al) > 100)

    # Tap 'No alerts armed' -> back to watchlist.
    click()
    time.sleep(1.5)

    # 10. Scroll down once (wraps focus 6 -> 0 = BTC), tap -> BTC detail.
    down()
    click()
    time.sleep(1.5)

    # 11. Scroll down -> actions list.
    down()
    acts = shot("10-actions-list")
    check("actions list opens", lit_pixels(acts) > 100)

    # 12. Click first item -> Buy $25 BTC (paper) -> confirm screen.
    click()
    confirm = shot("11-confirm-trade")
    check("confirm screen opens", lit_pixels(confirm) > 100)

    # 13. Tap again -> confirm the trade, back home.
    click()
    bought = shot("12-home-after-buy")
    check("paper buy returns home lit", lit_pixels(bought) > 100)

    # 14. Arm a +/-1% alert (the new tight marker).
    # Actions list now: Buy, Sell, Alert above +1%, Alert below -1%,
    # Alert above +5%, Alert below -5%, Back to price.
    down()  # open actions
    down()  # focus Buy -> Sell
    down()  # focus Sell -> Alert above +1%
    focused = shot("13-actions-alert-focused")
    check("alert row focused", lit_pixels(focused) > 100)
    click()  # arm the alert
    time.sleep(2.0)
    armed = shot("14-home-alert-armed")
    check("alert arm returns home lit", lit_pixels(armed) > 100)

    # Console must be free of errors / uncaught exceptions / failed fetches.
    console = get_json("/api/console")
    bad = [
        e
        for e in console.get("entries", [])
        if any(
            k in str(e.get("message", "")).lower()
            for k in ("uncaught", "failed to fetch", "typeerror", "referenceerror")
        )
    ]
    check("console has no errors", not bad, f"{len(bad)} bad entries")

    composite_views()
    print(f"\n{len(failures)} failure(s). Screenshots in ./{OUT}/")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
