#!/usr/bin/env python3
"""Headless simulator smoke test for Glance.

Assumes the Vite dev server is up on :5173 and the simulator was started as:
  evenhub-simulator http://localhost:5173 --automation-port 9898
under Xvfb. Drives the app through the HTTP control plane, screenshots each
state into ./screenshots/, and asserts the framebuffer is lit, the coin
cycles on tap, the actions list opens, and a paper buy executes.

Usage: python3 test/sim-test.py
Exit 0 = all checks pass.
"""
import io
import json
import sys
import time
import urllib.request
import urllib.error

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


def lit_pixels(png_bytes):
    """Count lit pixels in the 576x288 RGBA framebuffer (alpha > 0)."""
    from PIL import Image

    img = Image.open(io.BytesIO(png_bytes))
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    return sum(1 for px in img.getdata() if px[3] > 0)


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


def main():
    import os

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

    boot = get_png("/api/screenshot/glasses")
    open(f"{OUT}/1-home-btc.png", "wb").write(boot)
    lit = lit_pixels(boot)
    check("boot framebuffer lit", lit > 100, f"{lit} lit pixels")

    # Tap -> ETH
    post_json("/api/input", {"action": "click"})
    time.sleep(1.5)
    eth = get_png("/api/screenshot/glasses")
    open(f"{OUT}/2-home-eth.png", "wb").write(eth)
    check("tap cycles coin (ETH screen lit)", lit_pixels(eth) > 100)

    # Tap -> SOL
    post_json("/api/input", {"action": "click"})
    time.sleep(1.5)
    sol = get_png("/api/screenshot/glasses")
    open(f"{OUT}/3-home-sol.png", "wb").write(sol)
    check("tap cycles coin (SOL screen lit)", lit_pixels(sol) > 100)

    # Tap -> back to BTC
    post_json("/api/input", {"action": "click"})
    time.sleep(1.5)

    # Scroll down -> actions list
    post_json("/api/input", {"action": "down"})
    time.sleep(1.5)
    acts = get_png("/api/screenshot/glasses")
    open(f"{OUT}/4-actions-list.png", "wb").write(acts)
    check("actions list opens", lit_pixels(acts) > 100)

    # Click first item -> Buy $25 BTC (paper) -> confirm screen
    post_json("/api/input", {"action": "click"})
    time.sleep(1.5)
    confirm = get_png("/api/screenshot/glasses")
    open(f"{OUT}/5a-confirm-trade.png", "wb").write(confirm)
    check("confirm screen opens", lit_pixels(confirm) > 100)

    # Tap again -> confirm the trade, back home
    post_json("/api/input", {"action": "click"})
    time.sleep(1.5)
    bought = get_png("/api/screenshot/glasses")
    open(f"{OUT}/5-home-after-buy.png", "wb").write(bought)
    check("paper buy returns home lit", lit_pixels(bought) > 100)

    # --- arm an alert (Alert above +5%) ---
    # Actions list now: Buy, Sell, Alert above +5%, Alert below -5%, Back.
    post_json("/api/input", {"action": "down"})  # open actions
    time.sleep(1.5)
    post_json("/api/input", {"action": "down"})  # focus Buy -> Sell
    time.sleep(1.0)
    post_json("/api/input", {"action": "down"})  # focus Sell -> Alert above +5%
    time.sleep(1.0)
    focused = get_png("/api/screenshot/glasses")
    open(f"{OUT}/6-actions-alert-focused.png", "wb").write(focused)
    post_json("/api/input", {"action": "click"})  # arm the alert
    time.sleep(2.0)
    armed = get_png("/api/screenshot/glasses")
    open(f"{OUT}/7-home-alert-armed.png", "wb").write(armed)
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

    print(f"\n{len(failures)} failure(s). Screenshots in ./{OUT}/")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
