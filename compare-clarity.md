# Glance v2.1 — clarity comparison (measured)

Written 2026-11-27. The owner looked at the rival screenshots and said
CryptoGlance reads clearer, bigger, thicker — and that ours should feel
that comfortable without becoming a copy. This doc measures the gap,
finds what is real vs what is presentation, and records the v2.1 fixes.

## How the screenshots were made (this matters most)

- **Ours** (`screenshots/*-view.png`): raw RGBA framebuffer from the
  official Even Hub simulator, composited on black. What the glasses
  firmware actually draws.
- **CryptoGlance** (`compare/rivals/cryptoglance-glasses-*.png`):
  captured by their `scripts/verify.mjs` from
  `document.getElementById('glasses')` — the **browser-preview DOM
  element**, not the simulator. Their `index.html` styles that preview
  with CSS: `#pv-header { font-size: 19px; font-weight: 700 }`,
  `#pv-body { font-size: 17px; line-height: 1.45 }`,
  `.pv-item { font-size: 18px }`,
  `.pv-item.sel { background: #4dff88; color: #02140a; font-weight: 700 }`.
  Their demo video is the same browser preview (frame caption:
  "Demo recording — in-browser 576×288 preview · screens identical to
  the glasses"), despite DEMO-VIDEO.md saying it would be the simulator.
- **Consequence:** the filled bright-green selection bar and the bold
  glyphs in their screenshots are **CSS in a web page**. They do not
  exist on the glasses. No app can ship them — the firmware renders
  one fixed monospace-like face at one size for every app, and the SDK
  (0.0.10 and 0.0.16 alike) exposes no font, size, weight or colour
  field for text. Their "screens identical to the glasses" claim is
  unverified and, on the evidence of their own CSS, false in detail.

## Measured differences (all 576×288, pixel bands from /tmp/measure.py)

Stroke width = median horizontal lit-run length through a text row.

| screen | lines | blanks | row pitch | glyph height | stroke | selection |
|---|---|---|---|---|---|---|
| CG watchlist (preview) | 7 bands | 108px void under header | 25px | 16px body, 19px header | 2px body, 3px header | filled bar, 23px tall, full width, dark text |
| CG detail (preview) | 11 bands | 6–14px gaps | 25px | 16–18px | 2px | filled bar, 23px tall |
| CG portfolio (preview) | 6 bands | 133px void mid-screen | 25px | 16–20px | 2px | filled bar, 23px tall |
| Glance v2 watchlist (sim) | 8 bands | none | 27px | 16–20px | 1px | ">" cursor only |
| Glance v2 detail (sim) | 7 bands | 36px after header | 27px | 16–21px | 1px | none (text screen) |
| Glance v2 portfolio (sim) | 6 bands | none, gaps 4–9px | 27px | 16–23px | 1px | none (text screen) |
| Glance v2 actions (sim) | 6 items | native list spacing | ~30px | 16–20px | 1px | outline rounded-rect box, 40px tall |

What the numbers say:

1. **Glyph height is a tie.** Our firmware glyphs are 16–21px tall, theirs
   16–20px. Nothing to gain there.
2. **Stroke is 1px (ours, firmware) vs 2px (theirs, Chromium + CSS).**
   The "thicker" look is the preview's `font-weight: 700` on the
   selected row and 19px bold header — DOM rendering, not glasses.
   No SDK call can reproduce it.
3. **The real gap is air and selection.** Their watchlist has a 108px
   void under the header; their portfolio has a 133px void mid-screen;
   their rows sit on a 25px pitch with 6–14px gaps and a full-width
   filled selection bar. Our v2 watchlist and portfolio pack 6–8 lines
   with zero blank lines and a 1-character ">" cursor. That is the
   whole honest gap — and it is fixable on real glasses.
4. **Our actions/alerts lists already have the native selection.**
   The SDK list container draws the focused item as an outline
   rounded-rect box (sim-verified). That is the clearest selection the
   glasses offer; CryptoGlance's filled bar is not a glasses feature.

## SDK 0.0.16 check (verified in the real .d.ts, not assumed)

Downloaded `@evenrealities/even_hub_sdk@0.0.16` from npm and diffed
its `index.d.ts` against our 0.0.10. New in 0.0.16: `AudioEvent`,
`MenuContainerProperty` / `MenuItemProperty` (contextual menu),
`AppImageAsset`, `AppLocation`, `zOrderIndex` on containers, and
`textColor` (text brightness 0–4, default 4 = max) on
`TextContainerProperty`. **No font, size, weight or bold field.**
`textColor` at its default is already maximum brightness, so upgrading
buys zero readability. **Not upgrading for v2.1** — the cost (full
event-path re-verification) buys nothing. The contextual menu stays
deferred as in v2.

## What v2.1 changes (comfort, not a copy)

Goal: a tired eye finds every screen visible, comfortable, pleasant —
Glance keeps its own layout and identity.

1. **Watchlist becomes a real list.** Header text container
   (`GLANCE 12:17 LIVE`), a list container with the 5 coins only, and
   a footer hint. Focus gets the native outline box (the clearest
   selection the glasses have). The Portfolio/Alerts summary rows
   leave the watchlist — they live on their own screens, reached from
   the actions menu. **Measured catch:** the host resets list focus
   to 0 on `rebuildPageContainer` (sim-verified: focus box y=124 on
   SOL before a tick, y=44 on BTC after). So the tick rebuilds the
   watchlist only when focus is on row 0 or the user has been idle
   30s; while the user browses a non-zero row it refreshes the header
   clock only and leaves the list (and its focus) alone. A tap right
   after a rebuild would otherwise open the wrong coin. The reset is
   visible (the box moves), and the coin detail always shows fresh
   data when opened.
2. **Coin detail breathes.** The `Alert: none set` line only appears
   when an alert is actually armed; without one, a blank line takes
   its place before the hint. Max 8 lines, always at least one blank.
3. **Portfolio is rebuilt for calm.** Header, blank, Total as the hero
   figure, PnL, Cash, blank, then positions (0 → "No positions yet.";
   1–2 → both shown; 3+ → first + "+N more"), then the hint. Always
   exactly 8 lines, always with air around the total.
4. **Confirm gains a blank** after the title line.
5. **Actions menu grows two rows** — Portfolio and Alerts — so every
   screen stays reachable (coin detail → scroll → actions →
   Portfolio/Alerts). The list scrolls natively; verified in sim.

Kept from v2, unchanged: 5 coins, CoinGecko fallback + STALE tags,
±1%/±5% alerts, range bar, volume, avg cost, bridge storage,
paper-only trading with confirm screen.

## Background: option B is impossible, option C is impossible as drawn

The owner picked full inversion (B: black text on a full green
background). Verified against the SDK before implementing anything:

- **No fill field exists.** `TextContainerProperty` and
  `ListContainerProperty` in SDK 0.0.10 — and in 0.0.16, diffed field
  by field — have x/y/width/height, `borderWidth` (0–5),
  `borderColor` (0–15), `borderRadius`, `paddingLength`, id, name,
  event flag, and content/items. The SDK README documents every field;
  "background", "fill" and "invert" appear nowhere except "auto fill
  length" for item width. The only selection styling is
  `isItemSelectBorderEn`: "1 = show outer border when selected,
  0 = hidden" — an outline, never a fill.
- **Image containers cannot cover the screen.** `ImageContainerProperty`
  caps at 288×144 (a quarter of the 576×288 display) with slow BLE
  refresh. Four tiles could cover the screen in theory, but every
  price tick would need four bitmap re-renders plus four fragmented
  BLE uploads — a slideshow, not a live ticker — and image containers
  cannot take taps. Rejected; v2 already rejected image containers
  for live prices on the same grounds.
- **The "proof" that inversion exists is the same preview CSS.**
  CryptoGlance's filled selection bar is `.pv-item.sel { background:
  #4dff88; ... }` in their browser-preview stylesheet. On the real
  glasses their list renders with the same outline box as ours.
- **What shipped instead (framed bars):** every container carries a
  2px border, so the header, the list and the footer read as framed
  bands on the same green-on-black ground, and the selected row keeps
  the native outline box. It is the closest real treatment to the
  requested bars. This limit is now feature request #4 in the README.

## Focus behaviour, measured (not assumed)

- `rebuildPageContainer` **resets host list focus to 0** (sim:
  focus box y=124 on SOL before a tick, y=44 on BTC after).
- **Scrolls arrive silently.** Two `down` inputs produced zero app
  events in the console — the host moves its own focus, the app only
  learns the focused index from the tap itself (the click event
  carries `currentSelectItemIndex`; sim console confirms index 2 on
  a tap of the SOL row, and the tap opened SOL/USD).
- `textContainerUpgrade` **does not disturb focus** (sim: box stayed
  at y=124 across ticks while the header upgraded).
- Design consequence, in `src/main.ts`: the tick **never rebuilds**
  the watchlist while viewing it — header clock/tag only, via targeted
  upgrade. Prices refresh when the screen is re-entered. The watchlist
  header tag is honest about what is *displayed*: it reads STALE once
  the rendered list is 60s old (fixed a boot bug where it read STALE
  immediately — `listRenderedAt` now starts at boot time).
- **Selection verified on all five rows** (sim test, box tops
  46/86/126/166/206px — exactly one 40px row pitch per scroll) and
  the tap opens the focused coin (SOL tapped → SOL/USD detail).

## v2.1.1 — header/footer text vertically centred (owner spot)

The owner spotted it on the v2.1 watchlist screenshot: the header
("GLANCE 12:56 live") and footer ("Tap: open coin") text sat too low
in their framed bands, nearly touching the bottom border line.

- **Cause (measured):** the firmware's line slot is ~27px tall and
  top-anchored. In a 30px band the glyphs landed at bandTop+12..+27,
  i.e. 10px of air above and 1px below the bottom border. The SDK
  exposes no vertical-alignment field on `TextContainerProperty`
  (verified in the .d.ts: only geometry/border/padding/content),
  so the only levers are band height and padding.
- **Fix:** header/footer bands 30 -> 36px (list 224 -> 212, footer
  y258 -> y252, 2px gaps kept), and header/footer `paddingLength`
  4 -> 2, which lifts the glyphs 2px (the slot anchors to the padded
  content top). Measured after the fix: header glyphs at +10..+25
  (8px air above, 9px below), footer the same — centred within
  0.5px, clear of both borders on every screen.
- **Constraint that set 36, not 40:** the screen is 288px tall and
  the list needs 212px (exactly 5 x 40px rows) for the host to keep
  its uniform 40px row pitch. At 40px bands the list shrank to 204
  and the host squeezed the middle (SOL) row to 32px — caught by
  the sim test (box tops 48/88/128/160/200, steps 40/40/32/40).
  At 36px bands the pitch is back to uniform 40 (box tops
  46/86/126/166/206). The 1.5px of centring given up is invisible;
  an 8px-short row is not.
- **Other screens:** the full-screen text screens (coin detail,
  portfolio, confirm, alert) have no header/footer bands; their
  first line already sits 10px clear of the top border and their
  last line 65px+ clear of the bottom border — no change needed.
  List screens (alerts/actions) were already fine.
- **Verified:** unit tests 0 failures; sim test 22/22 pass; demo
  re-recorded (100.1s, final frame shows the bought BTC position
  and the armed +1% alert).
