// Unit tests for Glance v2: store logic (paper trades + alerts +
// portfolio totals) and data formatting / parsing (no network).
// Run: node test/logic.test.ts  (Node 24 type-stripping, no deps)
// localStorage is stubbed with a Map.
let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
function approx(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) < eps
}

// Stub localStorage before the store module loads.
const mem = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v) },
  removeItem: (k: string) => { mem.delete(k) },
}

const s = await import('../src/store.ts')
const {
  loadStore, paperBuy, paperSell, armAlert, clearAlert, alertFired,
  holdingValue, holdingPnl, totalValue, totalPnl, serialize, parseStore,
  START_CASH, TRADE_USD,
} = s
const d = await import('../src/data.ts')
const { fmtUsd, fmtUsdExact, fmtPct, fmtCompact, rangePosition, rangeBar,
  change24h, isStale, parseCoinGeckoRow, COINS } = d

// --- fresh start ---
let st = loadStore()
check('fresh store', st.cash === START_CASH && Object.keys(st.holdings).length === 0
  && Object.keys(st.alerts).length === 0, `cash=${st.cash}`)
check('5 coins configured', COINS.length === 5 && COINS[3].symbol === 'XRP' && COINS[4].symbol === 'DOGE')

// --- paper buy ---
check('buy unaffordable returns message', paperBuy({ cash: 10, holdings: {}, alerts: {} }, 'BTC', 60000) === 'Not enough paper cash')
const r1 = paperBuy(st, 'BTC', 60000)
check('buy $25 @ 60000 ok', r1 === null && approx(st.holdings.BTC.qty, 25 / 60000) && st.cash === 975)
check('holding value', approx(holdingValue(st, 'BTC', 66000), (25 / 60000) * 66000))
check('holding pnl', approx(holdingPnl(st, 'BTC', 66000), ((66000 - 60000) * 25) / 60000))
const r2 = paperBuy(st, 'BTC', 66000)
check('second buy averages cost', r2 === null && approx(st.holdings.BTC.avgCost, (25 + 25) / (25 / 60000 + 25 / 66000)))
check('cash after 2 buys', st.cash === 950)

// --- portfolio totals ---
const prices = new Map([['BTC', 66000], ['ETH', 1700]])
check('total value = cash + holdings', approx(totalValue(st, prices), 950 + (25 / 60000 + 25 / 66000) * 66000))
check('total pnl vs $1000 start', approx(totalPnl(st, prices), totalValue(st, prices) - 1000))
// missing price falls back to avg cost
check('total value falls back to avg cost', approx(totalValue(st, new Map()), 950 + (25 / 60000 + 25 / 66000) * st.holdings.BTC.avgCost))

// --- persistence round-trip ---
const st2 = loadStore()
check('state persists', approx(st2.holdings.BTC.qty, st.holdings.BTC.qty) && st2.cash === 950)
check('serialize/parse round-trip', (() => {
  const parsed = parseStore(serialize(st))
  return !!parsed && parsed.cash === st.cash && approx(parsed.holdings.BTC.qty, st.holdings.BTC.qty)
})())
check('parseStore rejects garbage', parseStore('not json') === null && parseStore(null) === null)

// --- paper sell ---
const r3 = paperSell(st, 'BTC', 66000)
check('sell $25 ok', r3 === null && st.cash === 975)
check('sell nothing returns message', paperSell({ cash: 0, holdings: {}, alerts: {} }, 'ETH', 1700) === 'Nothing to sell')
// sell-all: holding worth less than $25 disappears
const small: s.StoreState = { cash: 1000, holdings: { SOL: { qty: 0.1, avgCost: 70 } }, alerts: {} }
paperSell(small, 'SOL', 70)
check('sell-all removes holding', !('SOL' in small.holdings) && approx(small.cash, 1007))

// --- alerts ---
const aUp = armAlert(st, 'BTC', 'above', 60000)
check('alert above = +5% (default)', approx(aUp.level, 63000), `level=${aUp.level}`)
check('alert above not fired below', !alertFired(aUp, 62999))
check('alert above fires at level', alertFired(aUp, 63000))
check('alert above fires over', alertFired(aUp, 70000))
const aTight = armAlert(st, 'SOL', 'above', 100, 1)
check('alert above +1%', approx(aTight.level, 101), `level=${aTight.level}`)
const aDown = armAlert(st, 'ETH', 'below', 1700)
check('alert below = -5%', approx(aDown.level, 1615), `level=${aDown.level}`)
check('alert below not fired above', !alertFired(aDown, 1616))
check('alert below fires at level', alertFired(aDown, 1615))
const aDown1 = armAlert(st, 'ETH', 'below', 1700, 1)
check('alert below -1%', approx(aDown1.level, 1683), `level=${aDown1.level}`)
clearAlert(st, 'BTC')
check('clear alert', !('BTC' in st.alerts))
check('TRADE_USD is 25', TRADE_USD === 25)

// --- formatting: tabular-mono discipline ---
check('fmtUsd big price, no cents', fmtUsd(61687.78) === '$61,688', fmtUsd(61687.78))
check('fmtUsd hundreds, 1dp', fmtUsd(692.4) === '$692.4', fmtUsd(692.4))
check('fmtUsd small, 2dp', fmtUsd(73.23) === '$73.23', fmtUsd(73.23))
check('fmtUsd sub-dollar, 4dp', fmtUsd(0.5832) === '$0.5832', fmtUsd(0.5832))
check('fmtUsd non-finite', fmtUsd(NaN) === '$--')
check('fmtUsdExact cents', fmtUsdExact(1024.5) === '$1,024.50', fmtUsdExact(1024.5))
check('fmtPct signed 1dp', fmtPct(1.74) === '+1.7%' && fmtPct(-0.83) === '-0.8%')
check('fmtCompact K/M', fmtCompact(12400) === '12.4K' && fmtCompact(1200000) === '1.2M' && fmtCompact(42) === '42')
check('change24h', approx(change24h({ price: 110, open24h: 100 } as any), 10))
const q = { price: 75, high24h: 100, low24h: 50 } as any
check('rangePosition middle', approx(rangePosition(q), 50))
check('rangeBar marker mid', rangeBar(q, 10) === '|-----*----|', rangeBar(q, 10))
check('rangeBar clamps at low', rangeBar({ price: 50, high24h: 100, low24h: 50 } as any, 10) === '|*---------|')
check('rangeBar clamps at high', rangeBar({ price: 100, high24h: 100, low24h: 50 } as any, 10) === '|---------*|')
check('isStale', isStale({ updatedAt: Date.now() - 61000 } as any) && !isStale({ updatedAt: Date.now() } as any))

// --- CoinGecko row parsing (offline fixture) ---
const gecko = parseCoinGeckoRow(
  { current_price: 100, price_change_percentage_24h: 10, high_24h: 110, low_24h: 90, total_volume: 5000 },
  { symbol: 'BTC', pair: 'BTC-USD', gecko: 'bitcoin' },
)
check('gecko row parses', gecko.price === 100 && gecko.source === 'coingecko' && approx(gecko.open24h, 100 / 1.1))
check('gecko row high/low/volume', gecko.high24h === 110 && gecko.low24h === 90 && gecko.volume24h === 5000)

console.log(`\n${failures} failure(s).`)
process.exit(failures ? 1 : 0)
