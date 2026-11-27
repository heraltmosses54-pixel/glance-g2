// Glance v2.1 — a crypto price ticker for Even Realities G2 smart glasses.
// Track 03 (Exchanges & Stocks). One glanceable screen per idea:
// a watchlist home, one coin detail per tap, a portfolio total,
// an alerts list, actions, and a confirm step before any paper trade.
// Tap = open/select. Scroll = move. Double-tap = exit (system dialog).
//
// Data: Coinbase public stats (no key, no account), CoinGecko fallback,
// last-good quote kept and marked STALE. No backend, no secrets.
// State: paper portfolio + alerts, bridge storage first, localStorage
// fallback. Paper trading only — no real money, ever.
//
// Typography note (see compare-v2.md and compare-clarity.md): the G2
// firmware renders every text container in one fixed monospace-like
// face at one size — the SDK exposes no font/size/colour control, and
// no webfont can reach the glasses. The premium feel comes from
// discipline, not a font file: one idea per screen, a hero price
// isolated by a blank line, tabular formatting (adaptive decimals,
// signed 1-decimal %, padded aligned columns), caps labels, clock +
// LIVE/STALE tag. v2.1 adds the comfort layer: the watchlist is a
// real list container (native outline-box focus + the list's own row
// spacing), every text screen keeps at least one blank line, and the
// portfolio is rebuilt around one calm hero figure. Background: the
// owner asked for a full inversion (black text on green); the SDK has
// no fill/background field on any container and image containers cap
// at 288x144 with slow BLE refresh, so full inversion is impossible
// on the glasses (see compare-clarity.md). The closest real treatment
// is FRAMED BARS: every screen's containers carry a 2px border, so
// the header, the list and the footer read as framed bands, and the
// selected row gets the native outline box. Green-on-black stays the
// ground; the frames are the colour. The Bloomberg-terminal school:
// when you cannot change the face, you win on grid and rhythm.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import {
  fetchAllQuotes,
  change24h,
  fmtUsd,
  fmtUsdExact,
  fmtPct,
  fmtCompact,
  fmtClock,
  rangeBar,
  isStale,
  COINS,
  type CoinQuote,
} from './data'
import {
  loadStore,
  saveStore,
  serialize,
  parseStore,
  KEY,
  holdingPnl,
  totalValue,
  totalPnl,
  paperBuy,
  paperSell,
  armAlert,
  clearAlert,
  disarmAlert,
  alertFired,
  TRADE_USD,
  type StoreState,
  type Holding,
  type Alert,
} from './store'

const POLL_MS = 5000
const NOTICE_MS = 8000
const STALE_MS = 60_000
const TEXT_ID = 1
const LIST_ID = 2

type View = 'watchlist' | 'home' | 'portfolio' | 'alerts' | 'actions' | 'alert' | 'confirm'

const store: StoreState = loadStore()
let view: View = 'watchlist'
let coinIndex = 0
const quotes = new Map<string, CoinQuote>()
let lastError: string | null = null
let notice: string | null = null
let noticeUntil = 0
let fired: { sym: string; alert: Alert; price: number } | null = null
let focusedAction = 0
let actions: string[] = []
let focusedAlert = 0
let alertRows: string[] = []
// Focused row on the watchlist: 0..4, one per coin. The host list
// widget owns the focus; the app only mirrors it from list events.
let watchFocus = 0

// A trade the user tapped but has not confirmed yet. The price is frozen
// at the moment of the tap, so the confirm screen always shows the exact
// price the trade will execute at.
interface PendingTrade {
  kind: 'buy' | 'sell'
  sym: string
  price: number
}
let pending: PendingTrade | null = null

const coin = (): string => COINS[coinIndex].symbol
const quoteOf = (sym: string): CoinQuote | undefined => quotes.get(sym)
const priceMap = (): Map<string, number> =>
  new Map([...quotes.entries()].map(([sym, q]) => [sym, q.price]))

function setNotice(text: string): void {
  notice = text
  noticeUntil = Date.now() + NOTICE_MS
}

function freshNotice(): string | null {
  return notice && Date.now() < noticeUntil ? notice : null
}

/** Persist to localStorage and mirror to bridge storage (best effort). */
function persist(): void {
  saveStore(store)
  if (bridge) {
    bridge.setLocalStorage(KEY, serialize(store)).catch(() => {})
  }
}

/** LIVE when at least one quote is fresh, STALE when all are old. */
function dataTag(): string {
  if (quotes.size === 0) return '...'
  const now = Date.now()
  for (const q of quotes.values()) if (!isStale(q, now, STALE_MS)) return 'LIVE'
  return 'STALE'
}

// ---------- watchlist (home screen) ----------
// Three containers, like a framed page: a header text container
// (clock + LIVE/STALE), a list container with the 5 coins only, and a
// footer hint. The list's native outline box is the selection — the
// clearest the glasses offer — and the list's own row spacing is the
// air. Portfolio/Alerts no longer sit on this screen; they live on
// their own screens, reached from the actions menu (coin detail ->
// scroll -> actions -> Portfolio/Alerts). Prices refresh by rebuilding
// the whole page each tick — with one guard (see refreshWatchlist):
// the host resets list focus to 0 on a rebuild, so while the user is
// browsing a non-zero row the tick only refreshes the header clock
// and leaves the list alone. A tap right after a rebuild would
// otherwise open the wrong coin.

function watchItems(): string[] {
  return COINS.map((c) => {
    const q = quoteOf(c.symbol)
    const price = q ? fmtUsd(q.price) : '...'
    const chg = q ? fmtPct(change24h(q)) : '--%'
    return `${c.symbol.padEnd(4)} ${price.padStart(10)} ${chg.padStart(6)}`
  })
}

function watchlistPage(): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
} {
  return {
    containerTotalNum: 3,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        // v2.1.1: 36px, not 30. The firmware's line slot is ~27px and
        // top-anchored, so in a 30px band the glyphs (y+12..y+27) ended
        // 1px above the bottom border — bottom-hugging, as the owner
        // spotted. At 36px the glyphs keep the same offset from the
        // top and gain ~7px of air below (10px above): centred within
        // 1.5px, and clearly clear of both borders. 36 (not 40) is
        // the height that still leaves the list 212px — exactly
        // 5 x 40px rows — so the list rows stay uniform; at 40px
        // bands the list shrank to 204 and the host squeezed the
        // middle row to 32px. See compare-clarity.md.
        // v2.1.1 (centering, second half): padding 2, not 4. The
        // firmware anchors the line slot to the padded content top,
        // so less top padding lifts the glyphs: at padding 4 the
        // glyphs sat at y+12..y+27 (10px air above, 6px below the
        // 36px band); at padding 2 they should sit at y+10..y+25
        // (8px above, 8px below — centred). Verified by measurement
        // in the sim (see compare-clarity.md); if a future SDK
        // changes this anchoring, re-measure rather than assuming.
        height: 36,
        borderWidth: 2,
        borderColor: 5,
        paddingLength: 2,
        containerID: TEXT_ID,
        containerName: 'watchlist-header',
        content: `GLANCE  ${fmtClock()}  ${watchTag()}`,
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 252,
        width: 576,
        // Same 30 -> 36 fix as the header: the footer text sat on its
        // bottom border for the same reason (and the same padding 2
        // centring as the header).
        height: 36,
        borderWidth: 2,
        borderColor: 5,
        paddingLength: 2,
        containerID: TEXT_ID + 10,
        containerName: 'watchlist-footer',
        content: 'Tap: open coin',
        isEventCapture: 0,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: 38,
        width: 576,
        // 212 = 288 - 36 (header) - 36 (footer) - 2*2 (gaps). Exactly
        // 5 x 40px rows (inner 200), so the host keeps the uniform
        // 40px pitch it used in v2.1 — no squeezed middle row.
        height: 212,
        borderWidth: 2,
        borderColor: 5,
        paddingLength: 4,
        containerID: LIST_ID,
        containerName: 'watchlist',
        itemContainer: new ListItemContainerProperty({
          itemCount: COINS.length,
          itemWidth: 568,
          isItemSelectBorderEn: 1,
          itemName: watchItems(),
        }),
        isEventCapture: 1,
      }),
    ],
  }
}

async function showWatchlist(): Promise<void> {
  view = 'watchlist'
  // A rebuild resets host list focus to 0; mirror that here so the
  // JS focus never goes stale.
  watchFocus = 0
  listRenderedAt = Date.now()
  await bridge.rebuildPageContainer(new RebuildPageContainer(watchlistPage()))
}

// When the watchlist rows were last rendered. The tick never rebuilds
// the list while viewing it (see refreshWatchlist), so this ages while
// the user browses — the header tag turns STALE at 60s so the screen
// never claims fresh prices it does not show. Initialised to boot
// time: the startup page renders the list immediately.
let listRenderedAt = Date.now()

/** Header tag for the watchlist: honest about what is DISPLAYED. */
function watchTag(): string {
  if (quotes.size === 0) return '...'
  if (Date.now() - listRenderedAt > 60_000) return 'STALE'
  return dataTag()
}

async function refreshWatchlist(): Promise<void> {
  if (view !== 'watchlist') return
  // Never rebuild the list while viewing it. Measured in the sim:
  // rebuildPageContainer resets host list focus to 0, and scrolls
  // arrive silently — the app only learns the focused index from the
  // tap itself — so a tick rebuild mid-browse would make the next tap
  // open the wrong coin. A targeted text upgrade does NOT reset focus
  // (sim-verified: focus box stayed on its row across ticks), so the
  // header clock + tag still tick while the list waits. Prices refresh
  // whenever the screen is re-entered (showWatchlist rebuilds), and
  // the coin detail always shows fresh data when opened.
  await bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: TEXT_ID,
        containerName: 'watchlist-header',
        content: `GLANCE  ${fmtClock()}  ${watchTag()}`,
      }),
    )
    .catch(() => {})
}

async function openWatchRow(): Promise<void> {
  coinIndex = Math.min(watchFocus, COINS.length - 1)
  await showHome()
}

// ---------- coin detail ----------
// One text container, 8 lines. The blank line after the header is the
// hero isolation: the price reads as the big figure because nothing
// crowds it — the same trick as a finance app's number-display slot.

function homeText(): string {
  const sym = coin()
  const q = quoteOf(sym)
  const lines: string[] = []
  lines.push(`${sym}/USD    ${fmtClock()}  ${dataTag()}`)
  lines.push('')
  if (!q) {
    lines.push('Loading live prices...')
    if (lastError) lines.push(`Offline: ${lastError}`)
    lines.push('')
    lines.push('Tap: next coin')
    lines.push('Scroll: actions')
    return lines.join('\n')
  }
  const chg = change24h(q)
  lines.push(`${fmtUsd(q.price)}  ${fmtPct(chg)}`)
  lines.push(`H ${fmtUsd(q.high24h)}  L ${fmtUsd(q.low24h)}  V ${fmtCompact(q.volume24h)}`)
  lines.push(`Range ${rangeBar(q)}`)
  const h = store.holdings[sym]
  if (h) {
    const pnl = holdingPnl(store, sym, q.price)
    const sign = pnl >= 0 ? '+' : '-'
    lines.push(`Paper ${h.qty.toFixed(4)} @ ${fmtUsd(h.avgCost)} (${sign}$${Math.abs(pnl).toFixed(2)})`)
  } else {
    lines.push('Paper: no position yet')
  }
  const a = store.alerts[sym]
  if (a) {
    const dir = a.direction === 'above' ? '>' : '<'
    lines.push(`Alert: ${dir} ${fmtUsd(a.level)} armed`)
  } else {
    // No alert armed: a blank line instead, so the hint below breathes
    // and the screen never reads as a solid block of text.
    lines.push('')
  }
  const n = freshNotice()
  if (n) lines.push(n)
  else lines.push('Tap: next · Scroll: actions')
  return lines.join('\n')
}

function homeContainer(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 2,
    borderColor: 5,
    paddingLength: 4,
    containerID: TEXT_ID,
    containerName: 'home',
    content: homeText(),
    isEventCapture: 1,
  })
}

async function showHome(): Promise<void> {
  view = 'home'
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({ containerTotalNum: 1, textObject: [homeContainer()] }),
  )
}

async function refreshHome(): Promise<void> {
  if (view !== 'home') return
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: TEXT_ID,
      containerName: 'home',
      content: homeText(),
    }),
  )
}

// ---------- portfolio ----------

// Calm by construction: header, a blank, the Total as the hero
// figure, PnL, Cash, then positions — always exactly 8 lines, always
// with air around the total. Positions are capped so the screen never
// overflows: 0 -> "No positions yet.", 1-2 -> both shown, 3+ -> first
// + "+N more" (the full detail lives on each coin's screen).
function portfolioText(): string {
  const prices = priceMap()
  const total = totalValue(store, prices)
  const pnl = totalPnl(store, prices)
  const lines: string[] = [
    'PORTFOLIO',
    '',
    `Total ${fmtUsdExact(total)}`,
    `PnL ${pnl >= 0 ? '+' : '-'}${fmtUsdExact(Math.abs(pnl))} (paper)`,
    `Cash ${fmtUsdExact(store.cash)}`,
  ]
  const held = Object.entries(store.holdings)
  const positionLine = ([sym, h]: [string, Holding]): string => {
    const price = prices.get(sym) ?? h.avgCost
    const p = holdingPnl(store, sym, price)
    const sign = p >= 0 ? '+' : '-'
    return `${sym} ${h.qty.toFixed(4)} ~ ${fmtUsd(h.qty * price)} (${sign}$${Math.abs(p).toFixed(2)})`
  }
  if (held.length === 0) {
    lines.push('', 'No positions yet.')
  } else if (held.length === 1) {
    lines.push('', positionLine(held[0]))
  } else if (held.length === 2) {
    lines.push(positionLine(held[0]), positionLine(held[1]))
  } else {
    lines.push(positionLine(held[0]), `+${held.length - 1} more position(s)`)
  }
  lines.push('Tap: back to watchlist')
  return lines.join('\n')
}

function portfolioContainer(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 2,
    borderColor: 5,
    paddingLength: 4,
    containerID: TEXT_ID,
    containerName: 'portfolio',
    content: portfolioText(),
    isEventCapture: 1,
  })
}

async function showPortfolio(): Promise<void> {
  view = 'portfolio'
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({ containerTotalNum: 1, textObject: [portfolioContainer()] }),
  )
}

async function refreshPortfolio(): Promise<void> {
  if (view !== 'portfolio') return
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: TEXT_ID,
      containerName: 'portfolio',
      content: portfolioText(),
    }),
  )
}

// ---------- alerts list ----------

function buildAlertRows(): string[] {
  const rows: string[] = []
  for (const [sym, a] of Object.entries(store.alerts)) {
    const dir = a.direction === 'above' ? '>' : '<'
    rows.push(`Delete: ${sym} ${dir} ${fmtUsd(a.level)}`)
  }
  if (rows.length === 0) rows.push('No alerts armed')
  rows.push('Back to watchlist')
  return rows
}

async function showAlerts(): Promise<void> {
  view = 'alerts'
  alertRows = buildAlertRows()
  focusedAlert = 0
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1,
      listObject: [
        new ListContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 2,
          borderColor: 5,
          paddingLength: 4,
          containerID: LIST_ID,
          containerName: 'alerts',
          itemContainer: new ListItemContainerProperty({
            itemCount: alertRows.length,
            itemWidth: 568,
            isItemSelectBorderEn: 1,
            itemName: alertRows,
          }),
          isEventCapture: 1,
        }),
      ],
    }),
  )
}

async function runAlertRow(index: number): Promise<void> {
  const label = alertRows[index]
  if (!label) return
  if (label === 'Back to watchlist' || label === 'No alerts armed') {
    await showWatchlist()
    return
  }
  // "Delete: BTC > $64,590" -> clear that coin's alert.
  const sym = label.split(' ')[1]
  if (sym) {
    clearAlert(store, sym)
    persist()
  }
  await showAlerts()
}

// ---------- actions list ----------

function buildActions(): string[] {
  const sym = coin()
  const items: string[] = [`Buy $${TRADE_USD} ${sym} (paper)`]
  if (store.holdings[sym]) items.push(`Sell $${TRADE_USD} ${sym} (paper)`)
  items.push('Alert above +1%')
  items.push('Alert below -1%')
  items.push('Alert above +5%')
  items.push('Alert below -5%')
  if (store.alerts[sym]) items.push('Clear alert')
  // Portfolio and Alerts live here now: the watchlist shows coins
  // only, so this menu is the way to every other screen.
  items.push('Portfolio')
  items.push('Alerts')
  items.push('Back to price')
  return items
}

async function showActions(): Promise<void> {
  view = 'actions'
  actions = buildActions()
  focusedAction = 0
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1,
      listObject: [
        new ListContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 2,
          borderColor: 5,
          paddingLength: 4,
          containerID: LIST_ID,
          containerName: 'actions',
          itemContainer: new ListItemContainerProperty({
            itemCount: actions.length,
            itemWidth: 568,
            isItemSelectBorderEn: 1,
            itemName: actions,
          }),
          isEventCapture: 1,
        }),
      ],
    }),
  )
}

// ---------- confirm screen ----------

async function showConfirm(): Promise<void> {
  if (!pending) return
  view = 'confirm'
  const verb = pending.kind === 'buy' ? 'Buy' : 'Sell'
  const cashAfter =
    pending.kind === 'buy'
      ? store.cash - TRADE_USD
      : store.cash + Math.min(TRADE_USD, (store.holdings[pending.sym]?.qty ?? 0) * pending.price)
  const content = [
    'Confirm trade',
    '',
    `${verb} $${TRADE_USD} ${pending.sym} @ ${fmtUsd(pending.price)}`,
    'Paper only - no real money',
    `Cash after: ${fmtUsdExact(cashAfter)}`,
    '',
    'Tap: confirm · Scroll: cancel',
  ].join('\n')
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 2,
          borderColor: 5,
          paddingLength: 4,
          containerID: TEXT_ID,
          containerName: 'home',
          content,
          isEventCapture: 1,
        }),
      ],
    }),
  )
}

async function executePending(): Promise<void> {
  if (!pending) {
    await showHome()
    return
  }
  const { kind, sym, price } = pending
  pending = null
  const err = kind === 'buy' ? paperBuy(store, sym, price) : paperSell(store, sym, price)
  setNotice(
    err ??
      (kind === 'buy'
        ? `Bought $${TRADE_USD} ${sym} @ ${fmtUsd(price)}`
        : `Sold $${TRADE_USD} ${sym} @ ${fmtUsd(price)}`),
  )
  persist()
  await showHome()
}

async function runAction(index: number): Promise<void> {
  const sym = coin()
  const q = quoteOf(sym)
  const label = actions[index]
  if (!label) return
  if (label === 'Back to price') {
    await showHome()
    return
  }
  if (label === 'Portfolio') {
    await showPortfolio()
    return
  }
  if (label === 'Alerts') {
    await showAlerts()
    return
  }
  if (!q) {
    setNotice('No live price yet — try again')
    await showHome()
    return
  }
  if (label.startsWith('Buy')) {
    // Money actions go through an explicit confirm screen first — the
    // same quick-confirm pattern real trading apps use, so a stray tap
    // can never move (paper) money by accident.
    pending = { kind: 'buy', sym, price: q.price }
    await showConfirm()
    return
  } else if (label.startsWith('Sell')) {
    pending = { kind: 'sell', sym, price: q.price }
    await showConfirm()
    return
  }
  const alertMatch = label.match(/^Alert (above|below) \+?(-?)(\d+)%$/)
  if (alertMatch) {
    const direction = alertMatch[1] as 'above' | 'below'
    const pct = Number(alertMatch[3])
    const a = armAlert(store, sym, direction, q.price, pct)
    const dir = direction === 'above' ? '>' : '<'
    setNotice(`Alert armed: ${sym} ${dir} ${fmtUsd(a.level)}`)
  } else if (label === 'Clear alert') {
    clearAlert(store, sym)
    setNotice(`Alert cleared for ${sym}`)
  }
  persist()
  await showHome()
}

// ---------- alert-fired screen ----------

async function showAlert(): Promise<void> {
  if (!fired) return
  view = 'alert'
  const dir = fired.alert.direction === 'above' ? 'crossed above' : 'fell below'
  const content = [
    'ALERT!',
    `${fired.sym} ${dir} ${fmtUsd(fired.alert.level)}`,
    `now ${fmtUsd(fired.price)}`,
    '',
    'Tap to dismiss',
  ].join('\n')
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 2,
          borderColor: 5,
          paddingLength: 4,
          containerID: TEXT_ID,
          containerName: 'home',
          content,
          isEventCapture: 1,
        }),
      ],
    }),
  )
}

// ---------- data polling ----------

async function tick(): Promise<void> {
  // Fetch every coin: the watchlist shows them all at once.
  let failed = false
  try {
    const fresh = await fetchAllQuotes(COINS)
    for (const [sym, q] of fresh) {
      quotes.set(sym, q)
      const a = store.alerts[sym]
      if (a && alertFired(a, q.price) && !fired) {
        fired = { sym, alert: a, price: q.price }
        disarmAlert(store, sym)
        persist()
      }
    }
    if (fresh.size === 0) failed = true
  } catch (e) {
    failed = true
    lastError = e instanceof Error ? e.message : 'fetch failed'
  }
  if (!failed) lastError = null
  try {
    if (fired && (view === 'home' || view === 'watchlist' || view === 'portfolio')) {
      await showAlert()
      return
    }
    if (view === 'home') await refreshHome()
    else if (view === 'watchlist') await refreshWatchlist()
    else if (view === 'portfolio') await refreshPortfolio()
  } catch (e) {
    console.error('[glance] display update failed', e)
  }
}

// ---------- events ----------

// CLICK_EVENT is 0 and protobuf omits zero-value fields, so a tap arrives
// as an envelope whose eventType is undefined. Resolve the default INSIDE
// the envelope check (see the template's note) — never default an absent
// envelope to CLICK.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const bridge = await waitForEvenAppBridge()

// Bridge storage is the sanctioned store on real glasses: if this device
// already has a state there, it wins over the WebView localStorage copy.
try {
  const raw = await bridge.getLocalStorage(KEY)
  const parsed = parseStore(raw || null)
  if (parsed) Object.assign(store, parsed)
} catch {
  // bridge storage unavailable -> localStorage state stands
}

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(watchlistPage()),
)
console.log('[glance] page created:', created === 0 ? 'success' : `failed (${created})`)

const unsubscribe = bridge.onEvenHubEvent((event) => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  // Double-tap exits from every screen — root-level check, always first.
  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    unsubscribe()
    return
  }

  const isClick =
    sysType === OsEventTypeList.CLICK_EVENT ||
    textType === OsEventTypeList.CLICK_EVENT ||
    listType === OsEventTypeList.CLICK_EVENT
  const isScrollDown =
    sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
    textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
    listType === OsEventTypeList.SCROLL_BOTTOM_EVENT
  const isScrollUp =
    sysType === OsEventTypeList.SCROLL_TOP_EVENT ||
    textType === OsEventTypeList.SCROLL_TOP_EVENT ||
    listType === OsEventTypeList.SCROLL_TOP_EVENT

  // List focus tracking: scrolls move focus, clicks select.
  if (event.listEvent && typeof event.listEvent.currentSelectItemIndex === 'number') {
    if (view === 'actions') focusedAction = event.listEvent.currentSelectItemIndex
    if (view === 'alerts') focusedAlert = event.listEvent.currentSelectItemIndex
    if (view === 'watchlist') {
      // The tap itself carries the focused index — scrolls arrive
      // silently, so this is the only moment the app learns it.
      watchFocus = event.listEvent.currentSelectItemIndex
    }
  }

  if (view === 'alert') {
    if (isClick) {
      fired = null
      void showHome()
    }
    return
  }

  if (view === 'confirm') {
    if (isClick) {
      void executePending()
      return
    }
    if (isScrollDown || isScrollUp) {
      pending = null
      void showActions()
    }
    return
  }

  if (view === 'actions') {
    if (isClick) void runAction(focusedAction)
    return
  }

  if (view === 'alerts') {
    if (isClick) void runAlertRow(focusedAlert)
    return
  }

  if (view === 'portfolio') {
    if (isClick || isScrollDown || isScrollUp) void showWatchlist()
    return
  }

  if (view === 'watchlist') {
    // The host list widget owns focus and scrolling; the app only
    // mirrors the focused index from list events and opens it on tap.
    if (isClick) {
      void openWatchRow()
      return
    }
    return
  }

  // Home view (coin detail).
  if (isClick) {
    coinIndex = (coinIndex + 1) % COINS.length
    void refreshHome()
    void tick()
    return
  }
  if (isScrollDown) {
    void showActions()
    return
  }
  if (isScrollUp) {
    void showWatchlist()
  }
})

// ---------- boot ----------

await tick().catch((e) => console.error('[glance] first tick failed', e))
console.log('[glance] ready')
setInterval(() => {
  void tick().catch((e) => console.error('[glance] tick failed', e))
}, POLL_MS)
