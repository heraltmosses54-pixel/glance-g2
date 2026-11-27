// Unit tests for the Glance store logic (paper trades + alerts).
// Run: node test/logic.test.ts  (Node 24 type-stripping, no deps)
// No network: localStorage is stubbed with a Map.
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
const { loadStore, paperBuy, paperSell, armAlert, clearAlert, alertFired,
  holdingValue, holdingPnl, START_CASH, TRADE_USD } = s

// --- fresh start ---
let st = loadStore()
check('fresh store', st.cash === START_CASH && Object.keys(st.holdings).length === 0
  && Object.keys(st.alerts).length === 0, `cash=${st.cash}`)

// --- paper buy ---
check('buy unaffordable returns message', paperBuy({ cash: 10, holdings: {}, alerts: {} }, 'BTC', 60000) === 'Not enough paper cash')
const r1 = paperBuy(st, 'BTC', 60000)
check('buy $25 @ 60000 ok', r1 === null && approx(st.holdings.BTC.qty, 25 / 60000) && st.cash === 975)
check('holding value', approx(holdingValue(st, 'BTC', 66000), (25 / 60000) * 66000))
check('holding pnl', approx(holdingPnl(st, 'BTC', 66000), ((66000 - 60000) * 25) / 60000))
const r2 = paperBuy(st, 'BTC', 66000)
check('second buy averages cost', r2 === null && approx(st.holdings.BTC.avgCost, (25 + 25) / (25 / 60000 + 25 / 66000)))
check('cash after 2 buys', st.cash === 950)

// --- persistence round-trip ---
const st2 = loadStore()
check('state persists', approx(st2.holdings.BTC.qty, st.holdings.BTC.qty) && st2.cash === 950)

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
check('alert above = +5%', approx(aUp.level, 63000), `level=${aUp.level}`)
check('alert above not fired below', !alertFired(aUp, 62999))
check('alert above fires at level', alertFired(aUp, 63000))
check('alert above fires over', alertFired(aUp, 70000))
const aDown = armAlert(st, 'ETH', 'below', 1700)
check('alert below = -5%', approx(aDown.level, 1615), `level=${aDown.level}`)
check('alert below not fired above', !alertFired(aDown, 1616))
check('alert below fires at level', alertFired(aDown, 1615))
clearAlert(st, 'BTC')
check('clear alert', !('BTC' in st.alerts))
check('TRADE_USD is 25', TRADE_USD === 25)

console.log(`\n${failures} failure(s).`)
process.exit(failures ? 1 : 0)
