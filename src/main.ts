// Glance v2 — a crypto price ticker for Even Realities G2 smart glasses.
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
// Typography note (see compare-v2.md): the G2 firmware renders every
// text container in one fixed monospace-like face at one size — the SDK
// exposes no font/size/colour control, and no webfont can reach the
// glasses. The premium feel comes from discipline, not a font file:
// one idea per screen, a hero price isolated by a blank line, tabular
// formatting (adaptive decimals, signed 1-decimal %, padded aligned
// columns), caps labels, clock + LIVE/STALE tag. The Bloomberg-terminal
// school: when you cannot change the face, you win on grid and rhythm.

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
// Focused row on the watchlist: 0..4 coins, 5 portfolio, 6 alerts.
let watchFocus = 0
const WATCH_ROWS = COINS.length + 2

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
// One text container, 8 lines — the most any 576x288 screen holds.
// Columns are padded so prices line up: the tabular-mono discipline.

function watchRow(sym: string, focused: boolean): string {
  const cursor = focused ? '>' : ' '
  const q = quoteOf(sym)
  const price = q ? fmtUsd(q.price) : '...'
  const chg = q ? fmtPct(change24h(q)) : '--%'
  return `${cursor} ${sym.padEnd(4)} ${price.padStart(10)} ${chg.padStart(6)}`
}

function watchlistText(): string {
  const lines: string[] = [`GLANCE  ${fmtClock()}  ${dataTag()}`]
  COINS.forEach((c, i) => lines.push(watchRow(c.symbol, watchFocus === i)))
  const total = totalValue(store, priceMap())
  const pnl = totalPnl(store, priceMap())
  const pnlStr = `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(0)}`
  lines.push(`${watchFocus === 5 ? '>' : ' '} Portfolio ${fmtUsdExact(total).padStart(9)} ${pnlStr}`)
  const nAlerts = Object.keys(store.alerts).length
  lines.push(`${watchFocus === 6 ? '>' : ' '} Alerts (${nAlerts})`)
  return lines.join('\n')
}

function watchlistContainer(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: TEXT_ID,
    containerName: 'watchlist',
    content: watchlistText(),
    isEventCapture: 1,
  })
}

async function showWatchlist(): Promise<void> {
  view = 'watchlist'
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({ containerTotalNum: 1, textObject: [watchlistContainer()] }),
  )
}

async function refreshWatchlist(): Promise<void> {
  if (view !== 'watchlist') return
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: TEXT_ID,
      containerName: 'watchlist',
      content: watchlistText(),
    }),
  )
}

async function openWatchRow(): Promise<void> {
  if (watchFocus < COINS.length) {
    coinIndex = watchFocus
    await showHome()
  } else if (watchFocus === COINS.length) {
    await showPortfolio()
  } else {
    await showAlerts()
  }
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
    lines.push('Alert: none set')
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
    borderWidth: 0,
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

function portfolioText(): string {
  const lines: string[] = ['PORTFOLIO']
  const prices = priceMap()
  const total = totalValue(store, prices)
  const pnl = totalPnl(store, prices)
  lines.push(`Total ${fmtUsdExact(total)}`)
  lines.push(`PnL ${pnl >= 0 ? '+' : '-'}${fmtUsdExact(Math.abs(pnl))} (paper)`)
  lines.push(`Cash ${fmtUsdExact(store.cash)}`)
  const held = Object.entries(store.holdings)
  if (held.length === 0) {
    lines.push('No positions yet.')
  } else {
    const shown = held.slice(0, 3)
    for (const [sym, h] of shown) {
      const price = prices.get(sym) ?? h.avgCost
      const p = holdingPnl(store, sym, price)
      const sign = p >= 0 ? '+' : '-'
      lines.push(`${sym} ${h.qty.toFixed(4)} ~ ${fmtUsd(h.qty * price)} (${sign}$${Math.abs(p).toFixed(2)})`)
    }
    if (held.length > 3) lines.push(`+${held.length - 3} more position(s)`)
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
    borderWidth: 0,
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
          borderWidth: 0,
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
          borderWidth: 0,
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
          borderWidth: 0,
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
          borderWidth: 0,
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
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [watchlistContainer()],
  }),
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
    if (isClick) {
      void openWatchRow()
      return
    }
    if (isScrollDown) {
      watchFocus = (watchFocus + 1) % WATCH_ROWS
      void refreshWatchlist()
      return
    }
    if (isScrollUp) {
      watchFocus = (watchFocus + WATCH_ROWS - 1) % WATCH_ROWS
      void refreshWatchlist()
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
