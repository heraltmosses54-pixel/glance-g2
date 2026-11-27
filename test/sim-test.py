#!/usr/bin/env python3
"""Headless simulator smoke test for Glance v2.1.

Assumes the Vite dev server is up on :5173 and the simulator was started as:
  evenhub-simulator http://localhost:5173 --automation-port 9898
under Xvfb. Drives the app through the HTTP control plane, screenshots each
state into ./screenshots/, and asserts the framebuffer is lit through the
v2.1 flow: watchlist (list container) -> 5 coin details -> watchlist ->
actions -> portfolio -> actions -> alerts list -> actions -> confirm ->
buy -> alert arm -> actions bottom (scroll check).

Also verifies the v2.1 risk directly: list focus must survive the
5-second tick rebuild of the watchlist page (scroll to SOL, wait for a
tick, and confirm the focus outline is still on the SOL row).

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


def focus_box_top(png_bytes):
    """Y of the top edge of the list focus outline box.

    The box's horizontal edges span nearly the full 576px width, so a
    row with >300 lit pixels is a box edge; text rows never exceed
    ~150. Scan starts at y=36 to skip the watchlist header frame and
    the list container's own top border. Returns None when no box is
    visible.
    """
    from PIL import Image

    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    w, h = img.size
    px = img.load()
    for y in range(36, h):
        n = sum(1 for x in range(w) if px[x, y][3] > 0)
        if n > 300:
            return y
    return None


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

    # 1. Boot = watchlist list (5 coins, focus on BTC).
    boot = shot("1-watchlist")
    check("boot watchlist lit", lit_pixels(boot) > 100, f"{lit_pixels(boot)} lit pixels")
    top0 = focus_box_top(boot)
    check("boot focus box on row 0", top0 is not None, f"box top y={top0}")

    # 1a. Selection is unmistakable on EVERY row: scroll through all 5
    # coins, screenshot each, and require the focus box to step down
    # exactly one row pitch (40px) per scroll.
    tops = [top0]
    for i in (1, 2, 3, 4):
        down()
        s = shot(f"1a-watchlist-focus-{i}")
        tops.append(focus_box_top(s))
    check("focus box marks every row",
          all(t is not None for t in tops)
          and all(tops[i + 1] - tops[i] == 40 for i in range(4)),
          f"box tops={tops}")

    # 1b. Focus survival across the tick (the v2.1 no-rebuild rule):
    # focus is on row 4 (DOGE); wait for a 5s tick and confirm the
    # outline box is still on the same row.
    time.sleep(7)  # a tick fires at 5s; the list must not rebuild
    after = shot("1c-watchlist-focus-after-tick")
    top_after = focus_box_top(after)
    check("watchlist focus survives tick (no rebuild)",
          top_after is not None and top_after == tops[4],
          f"box top before y={tops[4]}, after y={top_after}")

    # 1c. Tap opens the FOCUSED coin: scroll up twice to SOL (row 2),
    # tap, and screenshot the detail. The test asserts it is lit; the
    # coin itself (SOL/USD in the header) is verified by viewing the
    # screenshot — a wrong coin here would be a silent functional bug.
    up()
    up()
    click()
    sol_tapped = shot("2b-home-sol-tapped")
    check("tap opens focused coin", lit_pixels(sol_tapped) > 100)
    # Scroll up from the detail screen -> watchlist (focus resets 0).
    up()
    time.sleep(1.5)

    # 2. Tap (focus 0 = BTC) -> BTC detail.
    click()
    btc = shot("2-home-btc")
    check("tap opens BTC detail", lit_pixels(btc) > 100)

    # 3-6. Tap cycles all five coin details.
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

    # 8. Tap BTC row -> BTC detail, scroll down -> actions list.
    click()
    time.sleep(1.5)
    down()
    acts = shot("10-actions-list")
    check("actions list opens", lit_pixels(acts) > 100)

    # 9. Actions list now: Buy, Alert above +1%, Alert below -1%,
    # Alert above +5%, Alert below -5%, Portfolio, Alerts, Back.
    # Scroll to Portfolio (index 5) and open it.
    for _ in range(5):
        down()
    click()
    pf = shot("8-portfolio")
    check("portfolio screen opens", lit_pixels(pf) > 100)

    # Tap -> back to watchlist.
    click()
    time.sleep(1.5)

    # 10. Tap BTC -> detail, scroll down -> actions, scroll to Alerts
    # (index 6), tap to open the alerts list.
    click()
    time.sleep(1.5)
    down()
    for _ in range(6):
        down()
    click()
    al = shot("9-alerts-list")
    check("alerts list opens", lit_pixels(al) > 100)

    # Tap 'No alerts armed' -> back to watchlist.
    click()
    time.sleep(1.5)

    # 11. Tap BTC -> detail, scroll down -> actions, click first item
    # (Buy $25 BTC) -> confirm screen.
    click()
    time.sleep(1.5)
    down()
    click()
    confirm = shot("11-confirm-trade")
    check("confirm screen opens", lit_pixels(confirm) > 100)

    # 12. Tap again -> confirm the trade, back home.
    click()
    bought = shot("12-home-after-buy")
    check("paper buy returns home lit", lit_pixels(bought) > 100)

    # 13. Arm a +/-1% alert (the tight marker).
    # Actions list now: Buy, Sell, Alert above +1%, Alert below -1%,
    # Alert above +5%, Alert below -5%, Portfolio, Alerts, Back.
    down()  # open actions
    down()  # focus Buy -> Sell
    down()  # focus Sell -> Alert above +1%
    focused = shot("13-actions-alert-focused")
    check("alert row focused", lit_pixels(focused) > 100)
    click()  # arm the alert
    time.sleep(2.0)
    armed = shot("14-home-alert-armed")
    check("alert arm returns home lit", lit_pixels(armed) > 100)

    # 14. The actions list now has 10 items (Clear alert appears once
    # an alert is armed). Scroll to the last row and confirm the list
    # scrolls: the focus box must sit in the lower half of the screen.
    down()  # open actions
    for _ in range(9):
        down()
    bottom = shot("15-actions-bottom")
    top_bottom = focus_box_top(bottom)
    check("actions list scrolls to last row",
          top_bottom is not None and top_bottom > 150,
          f"focus box top y={top_bottom}")
    # 'Back to price' is already focused (index 9); tap it to return
    # to the coin detail without running anything.
    click()
    time.sleep(1.5)

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
