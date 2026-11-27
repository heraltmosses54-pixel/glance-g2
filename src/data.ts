// Live market data from Coinbase public APIs (no key, no account).
// Track 03 (Exchanges & Stocks) lists Coinbase as an allowed app.
// Both endpoints send `Access-Control-Allow-Origin: *`, so they work from
// the G2 WebView directly — no backend, no secrets, no API keys.

export interface CoinQuote {
  symbol: string // BTC, ETH, SOL
  price: number // USD, latest
  open24h: number // USD, 24h open
  high24h: number // USD, 24h high
  low24h: number // USD, 24h low
  volume24h: number // base units traded in 24h
  updatedAt: number // ms epoch
}

const SPOT = (sym: string) =>
  `https://api.coinbase.com/v2/prices/${sym}-USD/spot`
const STATS = (sym: string) =>
  `https://api.exchange.coinbase.com/products/${sym}-USD/stats`

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return res.json()
}

function asNum(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  if (!Number.isFinite(n)) throw new Error(`bad number: ${String(v)}`)
  return n
}

/** One coin, one round trip for price + one for 24h stats. */
export async function fetchQuote(symbol: string): Promise<CoinQuote> {
  const [spot, stats] = await Promise.all([
    getJson(SPOT(symbol)) as Promise<{ data: { amount: string } }>,
    getJson(STATS(symbol)) as Promise<{
      open: string
      high: string
      low: string
      last: string
      volume: string
    }>,
  ])
  const price = asNum(spot.data.amount)
  return {
    symbol,
    price,
    open24h: asNum(stats.open),
    high24h: asNum(stats.high),
    low24h: asNum(stats.low),
    volume24h: asNum(stats.volume),
    updatedAt: Date.now(),
  }
}

export function change24h(q: CoinQuote): number {
  if (q.open24h <= 0) return 0
  return ((q.price - q.open24h) / q.open24h) * 100
}

export function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}%`
}
