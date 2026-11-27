# Glance v2 — comparison & gap analysis

Written 2026-11-27 during the build window (Nov 23–29). v1 is submitted
(DoraHacks build 52131, Under Review); v2 revises it before judging.
Judging weights (DoraHacks page): Usefulness 25% · Read-and-write 20% ·
Technical execution 20% · UX for display and voice 15% · Business
potential & safety 20%.

Sources read, not summarized: the full source of both rival repos
(cloned to `compare/`, read-only study, never built or executed),
plus web research on Coinbase / Binance / TradingView / Apple Stocks.

## The rivals

### CryptoGlance — zynthlabsio/cryptoglance-even-realities (MIT)
5 coins (BTC/ETH/BNB/SOL/XRP), Track: Crypto & DeFi. Nov 19 pre-hackathon
prototype, declared as such in its README.
- **Watchlist screen**: all coins on one list — `SYM $price +x.x%` — tap a
  coin for detail. This is the home screen.
- **Detail screen**: price + 24h change, high/low, position qty + value,
  **avg cost**, cash. Actions: buy/sell $10, alert ±5%, back.
- **Portfolio screen**: cash, total value, PnL vs $1,000 start, every
  position with qty + value.
- **Alerts screen**: lists all alerts, tap one to delete it.
- **Confirm screen** with qty + cash-after; message screens for feedback
  ("Paper buy done", "Alert set").
- **Data**: Binance primary → CoinGecko fallback → bundled sample data
  flagged `DEMO` in the header. Never goes blank.
- **Header/footer layout**: header `CryptoGlance HH:MM LIVE|DEMO`,
  footer hints, body in between. Signature-based render skip.
- **SDK 0.0.16 + contextual menu** (Refresh / Portfolio / Alerts / Back).
- **Browser preview**: the same projection renders a pixel-exact 576×288
  DOM mirror for development.
- **Storage**: `bridge.getLocalStorage/setLocalStorage` when a bridge is
  present, `localStorage` fallback.

### Market Glance — pikrimahardhika-alt/even-market-glance (NO license)
Coinbase BTC/ETH/SOL, Track: Exchanges & Stocks. Nov 19–20 pre-hackathon
prototype, explicitly NOT submitted. Patterns only — no code reuse.
- **Glance vs detail modes**: tap toggles a compact glance screen and a
  detail screen (open/high/low/volume/as-of).
- **24h range position**: `rangePosition()` — where the price sits in its
  24h low–high band, shown as a bar with a pin in the web preview.
- **Volume**: compact format (`12.4K BTC`) on the detail screen.
- **As-of timestamp + STALE flag**: `AS OF 11:42 UTC`, cached data marked
  STALE and never used to evaluate markers.
- **±1% markers** via contextual menu (SDK 0.0.16), persisted in bridge
  local storage, restored across restarts.
- **Stats validation**: rejects non-finite / impossible stats
  (high < low, negative volume).
- **One endpoint per coin**: Coinbase stats `last` is the price — no
  separate spot call.
- **Web preview**: full landing page with a device frame and live quote
  panel (development aid, not a glasses feature).
- **RESEARCH.md**: the best single document on the SDK/docs I found —
  event types, menu limits (10 items, 32-byte labels), simulator
  automation endpoints, storage API.

## Real apps — patterns worth stealing

Researched: Coinbase app, Binance, TradingView, Apple Stocks.

- **Coinbase home**: Portfolio Balance total on top, then a Watchlist
  (symbol, price, 24h % change, mini sparkline per row). Asset page:
  chart, market cap, **24h volume**, circulating supply, all-time high.
  Price alerts per watched asset (bell with unread count).
- **Binance**: BinanceNova for labels, **BinancePlex for all numbers** —
  tabular by default; number-display 40px/700. Five live regions with
  hard boundaries; colour reserved for direction.
- **TradingView**: three zoom levels — watchlist (symbol, last price,
  change in absolute AND %), symbol detail (full quote), narrative.
  SingleTicker widget: symbol, price, absolute + % change, direction.
- **Apple Stocks**: San Francisco with tabular numerals
  (`font-variant-numeric: tabular-nums`), huge price figure, strict
  size hierarchy (price ≫ change > labels > captions).
- **Universal**: watchlist is the home screen everywhere; portfolio
  total is always visible; every asset row shows price + 24h %;
  volume and range are on the detail screen; numbers are tabular so
  live updates never jitter the layout.

## Typography — what the real apps do, and what G2 allows

Real apps split type in two: a clean geometric sans for labels
(CoinbaseSans, BinanceNova, SF Pro, Inter) and a **mono/tabular face
for every number** (CoinbaseMono, BinancePlex, `tabular-nums`).
Hierarchy is size: number-display ≫ labels ≫ captions. Tabular
numerals exist so a ticking price never reflows its column.

**G2 reality, verified 2026-11-27:**
- SDK 0.0.10 `TextContainerProperty` exposes NO font, size, or colour
  field (grepped the shipped `dist/index.d.ts` and `dist/index.js` —
  zero font identifiers). The glasses firmware renders every text
  container in its single built-in face at one fixed size; the
  simulator's framebuffer confirms it (v1 home: 8 uniform lines).
- A bundled webfont / whitelisted webfont **cannot reach the glasses**:
  the display is drawn by the Even App from SDK containers, not from
  the WebView DOM. Webfonts only affect the browser preview, which
  judges never see.
- `textColor: 4` (used by Market Glance) is silently dropped by the
  SDK's `toJson` pick — a no-op on 0.0.10.
- Image containers (max 288×144, slow BLE refresh) could carry
  pre-rendered text, but are unfit for live prices — rejected.
- The firmware face is monospace-like (even glyph widths). That is
  actually the right raw material: it IS the tabular face, for free.

**So the premium feel comes from the Bloomberg-terminal school, not
from a font file:** one idea per screen, hero-price isolation via a
blank line (a taller container cannot enlarge the glyphs — the font
is fixed-size, so air comes from line discipline, not container
height), tabular formatting (adaptive decimals, 1-decimal signed %,
padded aligned columns so rows never jitter), caps labels, clock +
LIVE/STALE tag. No font is swapped, because none can be — the
discipline is the type treatment.

## Gap analysis — Glance v1 vs rivals vs real apps

Ranked by judging value. ✅ = v1 already has it.

| # | Gap | Who has it | Judging weight hit | v2? |
|---|-----|-----------|-------------------|-----|
| 1 | **No watchlist home screen** — v1 boots on one coin; you must tap through coins blind. Every real app + CryptoGlance open on a list. | CryptoGlance, Coinbase, Binance, TradingView | Usefulness 25% + UX 15% | **YES** |
| 2 | **No portfolio screen** — v1 shows only the current coin's position. No total value / PnL anywhere. | CryptoGlance, Coinbase | Usefulness 25% | **YES** |
| 3 | **No data fallback, no freshness signal** — v1 is Coinbase-only; a failed fetch leaves "Loading…" / a silent stale quote, no as-of time. | CryptoGlance (3-tier fallback + DEMO tag), Market Glance (STALE + as-of) | Technical 20% | **YES** |
| 4 | **No range / volume on the coin screen** — v1 fetches volume but never shows it; no sense of where the price sits in its day. | Market Glance (range bar, volume), Coinbase, TradingView | UX 15% + Usefulness | **YES** |
| 5 | **No alerts list** — v1 shows only the current coin's alert; you cannot see or manage all alerts. | CryptoGlance (alerts screen + delete) | Usefulness 25% | **YES** |
| 6 | **Only 3 coins** — CryptoGlance covers 5. | CryptoGlance | Usefulness 25% | **YES** (+XRP, +DOGE) |
| 7 | **Single alert granularity (±5% only)** — Market Glance offers ±1% markers for tight moves. | Market Glance | Read/write 20% | **YES** (±1% added) |
| 8 | **localStorage only** — on real glasses the sanctioned store is the bridge API; both rivals prefer it. | Both rivals | Technical 20% | **YES** (bridge first, localStorage fallback) |
| 9 | **No avg cost on position** — CryptoGlance detail shows it; v1 shows qty + PnL only. | CryptoGlance | Usefulness | **YES** (on coin screen) |
| 10 | **Uniform wall of text, no typographic hierarchy** — one 576×288 container, 8 same-size lines; price is no bigger than the hint line. | CryptoGlance (header/body/footer zones), all real apps | UX 15% | **YES** (hero isolated by a blank line, tabular columns, caps labels, clock + LIVE/STALE) |
| 11 | **Two requests per coin per tick** (spot + stats) — Market Glance uses stats `last` only. | Market Glance | Technical 20% | **YES** (stats only) |
| 12 | **No browser preview** — both rivals render a 576×288 DOM mirror for development. | Both rivals | Technical (dev only) | NO — dev aid, zero judging value; demo video covers it |
| 13 | **No contextual menu (SDK 0.0.16)** — both rivals use the OS menu for actions. | Both rivals | Read/write 20% | NO — needs an SDK upgrade + full event-path re-verification; list actions are verified and cost at most one extra tap. Deferred, noted as a feature request already in our submission. |
| 14 | **No sparkline** — every real app shows one per row. | Coinbase, Binance, TradingView | UX 15% | NO — image containers refresh too slowly over BLE (our own feature request #5); the text range bar is the mono equivalent. |

## v2 scope (implemented)

1. **Watchlist home screen** (text container, `>` focus cursor):
   header `GLANCE HH:MM LIVE|STALE`, 5 coin rows
   (`BTC $61,688 +1.7%`), `Portfolio $1,024 +$24`, `Alerts (n)`.
   Scroll moves the cursor, tap opens the row. Live-updated via
   `textContainerUpgrade` (no rebuild, focus never resets).
2. **Portfolio screen**: total value, PnL vs $1,000 start, cash,
   every position (qty, value, PnL). Tap / scroll-up back to watchlist.
3. **Alerts screen** (list container): `Delete: BTC > $64,590` per
   alert + `Back to watchlist`.
4. **Data resilience**: stats-only fetch (one request/coin);
   CoinGecko fallback per coin on Coinbase failure; last-good quote
   kept and marked STALE after 60 s; `as of HH:MM` on every screen.
5. **Coin screen richness**: 24h range bar (`Low |----●-----| High`),
   compact volume, avg cost on the position line.
6. **5 coins**: BTC, ETH, SOL, XRP, DOGE (all Coinbase-listed;
   CoinGecko ids: bitcoin, ethereum, solana, ripple, dogecoin).
7. **±1% alert options** alongside ±5%.
8. **Bridge storage first**: `bridge.getLocalStorage/setLocalStorage`
   when a bridge is present, `localStorage` fallback; mirrored on
   every mutation.
9. **Avg cost** on the coin screen position line.
10. **Typographic treatment** (see section above): one idea per screen;
    hero price isolated by a blank line; adaptive decimals (≥1000 → 0dp,
    ≥100 → 1dp, ≥1 → 2dp, <1 → 4dp, CryptoGlance's `fmtUsd` pattern,
    reimplemented); 1-decimal signed percentages; padded aligned
    watchlist columns; caps labels; clock + LIVE/STALE tag. (Note: zones
    are done with line discipline inside one container, not with separate
    containers — a taller container cannot enlarge the fixed-size
    firmware glyphs, so the blank line is the honest way to get air.)

## What v2 deliberately does NOT copy

- CryptoGlance's Binance primary source (geo-blocked from some
  regions, and Coinbase is the Track 03 listed app we already use).
- Market Glance's Cloudflare Worker backend (v2 stays no-backend).
- Either rival's SDK 0.0.16 contextual menu (see #13 above).
- Any rival code verbatim: the patterns above are reimplemented in
  Glance's own style; the only near-direct reuse is the adaptive
  decimal formatting rule, which is a one-line idea, reimplemented.

## Attribution

- Even Realities official `minimal` template (MIT) — scaffold.
- CryptoGlance (MIT, © zynthlabsio) — studied; formatting and
  layout patterns adapted with attribution in the README.
- Market Glance (no license) — patterns only, no code.
- Real-app typography references: BinancePlex / CoinbaseMono /
  Inter / SF Pro tabular-numerals practice (see Typography section).
