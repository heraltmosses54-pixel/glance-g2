// Live market data for Glance v2.
// Primary: Coinbase public stats (no key, no account) — one request per
// coin; the stats `last` field IS the latest price, so no separate spot
// call (Market Glance pattern). Fallback: CoinGecko public markets API,
// one call for every coin that failed on Coinbase. If both fail, the
// caller keeps the last-good quote and marks it STALE — a finance app
// never goes blank (CryptoGlance pattern).
// Track 03 (Exchanges & Stocks) lists Coinbase as an allowed app.
// Both endpoints send `Access-Control-Allow-Origin: *`, so they work
// from the G2 WebView directly — no backend, no secrets, no API keys.

export interface CoinQuote {
  symbol: string // BTC, ETH, SOL, XRP, DOGE
  price: number // USD, latest
  open24h: number // USD, 24h open
  high24h: number // USD, 24h high
  low24h: number // USD, 24h low
  volume24h: number // base units traded in 24h
  updatedAt: number // ms epoch of the last GOOD fetch
  source: 'coinbase' | 'coingecko' // which API produced this quote
}

export interface CoinDef {
  symbol: string
  pair: string // Coinbase product id
  gecko: string // CoinGecko id
}

export const COINS: CoinDef[] = [
  { symbol: 'BTC', pair: 'BTC-USD', gecko: 'bitcoin' },
  { symbol: 'ETH', pair: 'ETH-USD', gecko: 'ethereum' },
  { symbol: 'SOL', pair: 'SOL-USD', gecko: 'solana' },
  { symbol: 'XRP', pair: 'XRP-USD', gecko: 'ripple' },
  { symbol: 'DOGE', pair: 'DOGE-USD', gecko: 'dogecoin' },
]

const STATS = (pair: string) =>
  `https://api.exchange.coinbase.com/products/${pair}/stats`
const GECKO = (ids: string) =>
  `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h`

async function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

function asNum(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  if (!Number.isFinite(n)) throw new Error(`bad number: ${String(v)}`)
  return n
}

/** One coin from Coinbase stats. Throws on any bad field. */
export async function fetchCoinbaseQuote(def: CoinDef): Promise<CoinQuote> {
  const stats = (await getJson(STATS(def.pair))) as {
    open: string
    high: string
    low: string
    last: string
    volume: string
  }
  const q: CoinQuote = {
    symbol: def.symbol,
    price: asNum(stats.last),
    open24h: asNum(stats.open),
    high24h: asNum(stats.high),
    low24h: asNum(stats.low),
    volume24h: asNum(stats.volume),
    updatedAt: Date.now(),
    source: 'coinbase',
  }
  if (q.open24h <= 0 || q.high24h < q.low24h || q.low24h < 0 || q.volume24h < 0) {
    throw new Error(`impossible stats for ${def.symbol}`)
  }
  return q
}

/** Every coin in `defs` from CoinGecko, one call. Throws if the call fails. */
export async function fetchCoinGeckoQuotes(defs: CoinDef[]): Promise<Map<string, CoinQuote>> {
  const ids = defs.map((d) => d.gecko).join(',')
  const rows = (await getJson(GECKO(ids))) as Array<Record<string, number | string>>
  const byId = new Map(rows.map((r) => [String(r.id), r]))
  const out = new Map<string, CoinQuote>()
  for (const d of defs) {
    const r = byId.get(d.gecko)
    if (!r) throw new Error(`coingecko missing ${d.gecko}`)
    out.set(d.symbol, parseCoinGeckoRow(r, d))
  }
  return out
}

/** One CoinGecko markets row -> CoinQuote. Exported for unit tests. */
export function parseCoinGeckoRow(r: Record<string, number | string>, d: CoinDef): CoinQuote {
  const price = Number(r.current_price)
  const chg = Number(r.price_change_percentage_24h ?? 0)
  const open = chg === -100 ? price : price / (1 + chg / 100)
  return {
    symbol: d.symbol,
    price,
    open24h: open,
    high24h: Number(r.high_24h ?? price),
    low24h: Number(r.low_24h ?? price),
    volume24h: Number(r.total_volume ?? 0),
    updatedAt: Date.now(),
    source: 'coingecko',
  }
}

/**
 * All coins, best effort. Coinbase first per coin; anything that fails
 * retries once via CoinGecko. Coins that fail on both are simply absent
 * from the returned map — the caller keeps its last-good quote.
 */
export async function fetchAllQuotes(defs: CoinDef[]): Promise<Map<string, CoinQuote>> {
  const out = new Map<string, CoinQuote>()
  const failed: CoinDef[] = []
  const results = await Promise.allSettled(defs.map((d) => fetchCoinbaseQuote(d)))
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.set(defs[i].symbol, r.value)
    else failed.push(defs[i])
  })
  if (failed.length > 0) {
    try {
      const fallback = await fetchCoinGeckoQuotes(failed)
      for (const [sym, q] of fallback) out.set(sym, q)
    } catch (e) {
      console.warn('[glance] coingecko fallback failed', e)
    }
  }
  return out
}

export function change24h(q: CoinQuote): number {
  if (q.open24h <= 0) return 0
  return ((q.price - q.open24h) / q.open24h) * 100
}

/** True when the quote is older than `maxAgeMs` (default 60 s). */
export function isStale(q: CoinQuote, now = Date.now(), maxAgeMs = 60_000): boolean {
  return now - q.updatedAt > maxAgeMs
}

// ---------- formatting: the tabular-mono discipline ----------
// The G2 firmware face is monospace-like with one fixed size, so numbers
// win their premium feel from fixed-width formatting, not from a font
// file (see compare-v2.md, Typography). Rules adapted from the
// BinancePlex / CoinbaseMono school: adaptive decimals, signed
// one-decimal percentages, compact volumes.

/** Adaptive decimals: big prices need no cents, sub-dollar coins need 4dp. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$--'
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US')
  if (n >= 100) return '$' + n.toFixed(1)
  if (n >= 1) return '$' + n.toFixed(2)
  return '$' + n.toFixed(4)
}

/** Exact cents, for cash / totals. */
export function fmtUsdExact(n: number): string {
  if (!Number.isFinite(n)) return '$--'
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Signed, one decimal — `+1.7%`, `-0.8%`. */
export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '--%'
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

/** Compact volume: `12.4K`, `1.2M`. */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '--'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${Math.round(n)}`
}

/** HH:MM local clock for the header. */
export function fmtClock(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Where the price sits in its 24h low–high band, 0–100. */
export function rangePosition(q: CoinQuote): number {
  const span = q.high24h - q.low24h
  if (span <= 0) return 50
  return Math.min(100, Math.max(0, ((q.price - q.low24h) / span) * 100))
}

/**
 * Text range bar, e.g. `|----●-----|` — the mono equivalent of the
 * range bar every real finance app draws. ASCII-safe: the G2 firmware
 * face is only proven for ASCII glyphs.
 */
export function rangeBar(q: CoinQuote, width = 10): string {
  const pos = rangePosition(q)
  const idx = Math.min(width - 1, Math.max(0, Math.round((pos / 100) * (width - 1))))
  const cells = Array<string>(width).fill('-')
  cells[idx] = '*'
  return `|${cells.join('')}|`
}
