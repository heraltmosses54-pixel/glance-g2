// Paper portfolio + price alerts. Everything is pretend money:
// no real orders, no funds, no keys. State persists in localStorage
// and, when a bridge is present, in the Even Hub bridge store too
// (main.ts mirrors it there — the sanctioned store on real glasses).
// Both rivals prefer bridge storage; localStorage is the fallback.

export interface Holding {
  qty: number
  avgCost: number // USD per coin
}

export interface Alert {
  direction: 'above' | 'below'
  level: number // USD price that triggers it
}

export interface StoreState {
  cash: number // paper USD
  holdings: Record<string, Holding>
  alerts: Record<string, Alert>
}

export const START_CASH = 1000
export const KEY = 'glance-v1'
export const TRADE_USD = 25 // every paper trade is $25 of the coin

export function serialize(s: StoreState): string {
  return JSON.stringify(s)
}

/** Parse a stored state; null when the text is missing or corrupt. */
export function parseStore(raw: string | null): StoreState | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as StoreState
    if (typeof s.cash === 'number' && s.holdings && s.alerts) return s
  } catch {
    // corrupted storage -> fresh start
  }
  return null
}

export function loadStore(): StoreState {
  try {
    return parseStore(localStorage.getItem(KEY)) ?? { cash: START_CASH, holdings: {}, alerts: {} }
  } catch {
    return { cash: START_CASH, holdings: {}, alerts: {} }
  }
}

export function saveStore(s: StoreState): void {
  try {
    localStorage.setItem(KEY, serialize(s))
  } catch {
    // storage unavailable (private mode) -> keep running in memory
  }
}

export function holdingValue(s: StoreState, sym: string, price: number): number {
  const h = s.holdings[sym]
  return h ? h.qty * price : 0
}

export function holdingPnl(s: StoreState, sym: string, price: number): number {
  const h = s.holdings[sym]
  return h ? (price - h.avgCost) * h.qty : 0
}

/** Total portfolio value: cash + every holding at live prices. */
export function totalValue(s: StoreState, prices: Map<string, number>): number {
  let total = s.cash
  for (const [sym, h] of Object.entries(s.holdings)) {
    total += h.qty * (prices.get(sym) ?? h.avgCost)
  }
  return total
}

/** Total P&L vs the $1,000 starting cash. */
export function totalPnl(s: StoreState, prices: Map<string, number>): number {
  return totalValue(s, prices) - START_CASH
}

/** Buy $25 of the coin at the given price. Returns a message or null if unaffordable. */
export function paperBuy(s: StoreState, sym: string, price: number): string | null {
  if (s.cash < TRADE_USD) return 'Not enough paper cash'
  const qty = TRADE_USD / price
  const h = s.holdings[sym]
  if (h) {
    const totalCost = h.qty * h.avgCost + TRADE_USD
    h.qty += qty
    h.avgCost = totalCost / h.qty
  } else {
    s.holdings[sym] = { qty, avgCost: price }
  }
  s.cash -= TRADE_USD
  saveStore(s)
  return null
}

/** Sell $25 of the coin at the given price (or everything if worth less). */
export function paperSell(s: StoreState, sym: string, price: number): string | null {
  const h = s.holdings[sym]
  if (!h || h.qty <= 0) return 'Nothing to sell'
  const value = h.qty * price
  const sellValue = Math.min(TRADE_USD, value)
  const sellQty = sellValue / price
  h.qty -= sellQty
  s.cash += sellValue
  if (h.qty < 1e-9) delete s.holdings[sym]
  saveStore(s)
  return null
}

/**
 * Arm a price alert `pct` percent above/below the given price.
 * Default 5% (v1 behaviour); 1% is the tight marker both rivals offer.
 */
export function armAlert(
  s: StoreState,
  sym: string,
  direction: 'above' | 'below',
  price: number,
  pct = 5,
): Alert {
  const factor = direction === 'above' ? 1 + pct / 100 : 1 - pct / 100
  const a: Alert = { direction, level: price * factor }
  s.alerts[sym] = a
  saveStore(s)
  return a
}

export function clearAlert(s: StoreState, sym: string): void {
  delete s.alerts[sym]
  saveStore(s)
}

export function disarmAlert(s: StoreState, sym: string): void {
  delete s.alerts[sym]
  saveStore(s)
}

/** True when the live price has crossed the armed alert level. */
export function alertFired(a: Alert, price: number): boolean {
  return a.direction === 'above' ? price >= a.level : price <= a.level
}
