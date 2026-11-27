// Glance — a crypto price ticker for Even G2 smart glasses.
// Track 03 (Exchanges & Stocks). One glanceable screen per coin:
// live price, 24h change, high/low, paper position, armed alert.
// Tap = next coin. Scroll down = actions (paper buy/sell, alerts).
// Double-tap = exit (system dialog, required on the root page).
//
// Data: Coinbase public market data (no key, no account) —
// spot price + 24h stats, both CORS-enabled, so the app works
// from the glasses WebView with no backend and no secrets.

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
import { fetchQuote, change24h, fmtUsd, fmtPct, type CoinQuote } from './data'
import {
  loadStore,
  saveStore,
  holdingPnl,
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

const COINS = ['BTC', 'ETH', 'SOL'] as const
type Coin = (typeof COINS)[number]
const POLL_MS = 5000
const NOTICE_MS = 8000
const HOME_ID = 1
const ACTIONS_ID = 2

type View = 'home' | 'actions' | 'alert' | 'confirm'

const store: StoreState = loadStore()
let view: View = 'home'
let coinIndex = 0
const quotes = new Map<string, CoinQuote>()
let lastError: string | null = null
let notice: string | null = null
let noticeUntil = 0
let fired: { sym: string; alert: Alert; price: number } | null = null
let focusedAction = 0
let actions: string[] = []

// A trade the user tapped but has not confirmed yet. The price is frozen
// at the moment of the tap, so the confirm screen always shows the exact
// price the trade will execute at.
interface PendingTrade {
  kind: 'buy' | 'sell'
  sym: Coin
  price: number
}
let pending: PendingTrade | null = null

const coin = (): Coin => COINS[coinIndex]
const quoteOf = (sym: string): CoinQuote | undefined => quotes.get(sym)

function setNotice(text: string): void {
  notice = text
  noticeUntil = Date.now() + NOTICE_MS
}

function freshNotice(): string | null {
  return notice && Date.now() < noticeUntil ? notice : null
}

// ---------- home screen ----------

function homeText(): string {
  const sym = coin()
  const q = quoteOf(sym)
  const lines: string[] = []
  lines.push(`${sym}/USD`)
  if (!q) {
    lines.push('Loading live prices...')
    if (lastError) lines.push(`Offline: ${lastError}`)
    lines.push('')
    lines.push('Tap: next coin')
    lines.push('Scroll: actions')
    return lines.join('\n')
  }
  const chg = change24h(q)
  lines.push(`$${fmtUsd(q.price)}`)
  lines.push(`${fmtPct(chg)} today   H $${fmtUsd(q.high24h)}`)
  lines.push(`Low $${fmtUsd(q.low24h)}`)
  const h = store.holdings[sym]
  if (h) {
    const pnl = holdingPnl(store, sym, q.price)
    const sign = pnl >= 0 ? '+' : ''
    lines.push(`Paper: ${h.qty.toFixed(4)} ${sym} (${sign}$${Math.abs(pnl).toFixed(2)})`)
  } else {
    lines.push('Paper: no position yet')
  }
  const a = store.alerts[sym]
  if (a) {
    const dir = a.direction === 'above' ? '>' : '<'
    lines.push(`Alert: ${dir} $${fmtUsd(a.level)} armed`)
  } else {
    lines.push('Alert: none set')
  }
  const n = freshNotice()
  if (n) lines.push(n)
  lines.push('Tap: next coin · Scroll: actions')
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
    containerID: HOME_ID,
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
      containerID: HOME_ID,
      containerName: 'home',
      content: homeText(),
    }),
  )
}

// ---------- actions screen ----------

function buildActions(): string[] {
  const sym = coin()
  const items: string[] = [`Buy $${TRADE_USD} ${sym} (paper)`]
  if (store.holdings[sym]) items.push(`Sell $${TRADE_USD} ${sym} (paper)`)
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
          containerID: ACTIONS_ID,
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
    `${verb} $${TRADE_USD} ${pending.sym} @ $${fmtUsd(pending.price)}`,
    'Paper only - no real money',
    `Cash after: $${fmtUsd(cashAfter)}`,
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
          containerID: HOME_ID,
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
        ? `Bought $${TRADE_USD} ${sym} @ $${fmtUsd(price)}`
        : `Sold $${TRADE_USD} ${sym} @ $${fmtUsd(price)}`),
  )
  saveStore(store)
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
  } else if (label === 'Alert above +5%') {
    const a = armAlert(store, sym, 'above', q.price)
    setNotice(`Alert armed: ${sym} > $${fmtUsd(a.level)}`)
  } else if (label === 'Alert below -5%') {
    const a = armAlert(store, sym, 'below', q.price)
    setNotice(`Alert armed: ${sym} < $${fmtUsd(a.level)}`)
  } else if (label === 'Clear alert') {
    clearAlert(store, sym)
    setNotice(`Alert cleared for ${sym}`)
  }
  saveStore(store)
  await showHome()
}

// ---------- alert screen ----------

async function showAlert(): Promise<void> {
  if (!fired) return
  view = 'alert'
  const dir = fired.alert.direction === 'above' ? 'crossed above' : 'fell below'
  const content = [
    'ALERT!',
    `${fired.sym} ${dir} $${fmtUsd(fired.alert.level)}`,
    `now $${fmtUsd(fired.price)}`,
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
          containerID: HOME_ID,
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
  // Fetch the visible coin plus any coin with an armed alert.
  const wanted = new Set<string>([coin()])
  for (const sym of Object.keys(store.alerts)) wanted.add(sym)
  let failed = false
  for (const sym of wanted) {
    try {
      const q = await fetchQuote(sym)
      quotes.set(sym, q)
      const a = store.alerts[sym]
      if (a && alertFired(a, q.price) && !fired) {
        fired = { sym, alert: a, price: q.price }
        disarmAlert(store, sym)
        saveStore(store)
      }
    } catch (e) {
      failed = true
      lastError = e instanceof Error ? e.message : 'fetch failed'
    }
  }
  if (!failed) lastError = null
  try {
    if (fired && view === 'home') {
      await showAlert()
      return
    }
    if (view === 'home') await refreshHome()
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

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [homeContainer()],
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

  // List focus tracking: scrolls move focus, clicks select.
  if (event.listEvent && typeof event.listEvent.currentSelectItemIndex === 'number') {
    focusedAction = event.listEvent.currentSelectItemIndex
  }

  if (view === 'alert') {
    if (
      sysType === OsEventTypeList.CLICK_EVENT ||
      textType === OsEventTypeList.CLICK_EVENT ||
      listType === OsEventTypeList.CLICK_EVENT
    ) {
      fired = null
      void showHome()
    }
    return
  }

  if (view === 'confirm') {
    if (
      sysType === OsEventTypeList.CLICK_EVENT ||
      textType === OsEventTypeList.CLICK_EVENT ||
      listType === OsEventTypeList.CLICK_EVENT
    ) {
      void executePending()
      return
    }
    if (
      sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
      textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
      sysType === OsEventTypeList.SCROLL_TOP_EVENT ||
      textType === OsEventTypeList.SCROLL_TOP_EVENT
    ) {
      pending = null
      void showActions()
    }
    return
  }

  if (view === 'actions') {
    if (listType === OsEventTypeList.CLICK_EVENT) {
      void runAction(focusedAction)
      return
    }
    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      void runAction(focusedAction)
    }
    return
  }

  // Home view.
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    coinIndex = (coinIndex + 1) % COINS.length
    void refreshHome()
    void tick()
    return
  }
  if (
    sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
    textType === OsEventTypeList.SCROLL_BOTTOM_EVENT
  ) {
    void showActions()
    return
  }
  if (
    sysType === OsEventTypeList.SCROLL_TOP_EVENT ||
    textType === OsEventTypeList.SCROLL_TOP_EVENT
  ) {
    coinIndex = (coinIndex + COINS.length - 1) % COINS.length
    void refreshHome()
    void tick()
  }
})

// ---------- boot ----------

await tick().catch((e) => console.error('[glance] first tick failed', e))
console.log('[glance] ready')
setInterval(() => {
  void tick().catch((e) => console.error('[glance] tick failed', e))
}, POLL_MS)
