// Multi-timeframe bars + indicators for every watchlist stock -> data/charts.json
//
// Kept out of quotes.json and out of git: it is large and fully rebuildable, and
// the Vercel build regenerates it. quotes.json stays small and tracked.
//
// Usage: node scripts/charts.ts
import { get, sma, ema, macd, kdj, rsi, readJSON, writeJSON, ROOT, lsJSON, type Bar } from './lib.ts';

/** Yahoo interval/range pairs. Anything finer than 1d only goes back a few days. */
export const TIMEFRAMES = [
  { id: '1m', label: '1 min', interval: '5m', range: '1d', bars: 80 },
  { id: '1d', label: 'Daily', interval: '1d', range: '6mo', bars: 90 },
  { id: '1wk', label: 'Weekly', interval: '1wk', range: '2y', bars: 90 },
  { id: '1mo', label: 'Monthly', interval: '1mo', range: '5y', bars: 60 },
];

const r = (x: number | null | undefined, dp = 2) =>
  x == null || !isFinite(x) ? null : Number(x.toFixed(dp));

async function series(symbol: string, interval: string, range: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?interval=${interval}&range=${range}`;
  const res = await get(url, { key: 'yahoo', minGapMs: 220, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const result = (await res.json())?.chart?.result?.[0];
  if (!result?.timestamp) throw new Error(`no ${interval} bars for ${symbol}`);
  const q = result.indicators.quote[0];
  return result.timestamp.map((t: number, i: number) => ({
    date: new Date(t * 1000).toISOString().slice(0, interval.endsWith('m') ? 16 : 10).replace('T', ' '),
    open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0,
  })).filter((b: Bar) => b.open != null && b.close != null);
}

/** Everything the chart panel needs for one timeframe. */
function withIndicators(b: Bar[], keep: number) {
  const c = b.map((x) => x.close), h = b.map((x) => x.high), l = b.map((x) => x.low);
  const m = macd(c), k = kdj(h, l, c), rs = rsi(c);
  const ma5 = sma(c, 5), ma10 = sma(c, 10), ma20 = sma(c, 20), ma50 = sma(c, 50);
  const cut = <T>(a: T[]) => a.slice(-keep);
  return {
    bars: cut(b).map((x) => ({
      d: x.date, o: r(x.open), h: r(x.high), l: r(x.low), c: r(x.close), v: x.volume,
    })),
    ma: { ma5: cut(ma5).map((v) => r(v)), ma10: cut(ma10).map((v) => r(v)),
          ma20: cut(ma20).map((v) => r(v)), ma50: cut(ma50).map((v) => r(v)) },
    macd: { line: cut(m.line).map((v) => r(v, 3)), signal: cut(m.signal).map((v) => r(v, 3)),
            hist: cut(m.hist).map((v) => r(v, 3)) },
    kdj: { k: cut(k.K).map((v) => r(v, 1)), d: cut(k.D).map((v) => r(v, 1)), j: cut(k.J).map((v) => r(v, 1)) },
    rsi: cut(rs).map((v) => r(v, 1)),
  };
}

const latest = lsJSON(`${ROOT}data/candidates`).pop();
const us = latest ? readJSON<any>(`${ROOT}data/candidates/${latest}`, { candidates: [] }).candidates : [];
const hk = readJSON<any>(`${ROOT}data/universe-hk.json`, { constituents: [] }).constituents;
const all = [...us, ...hk];

const out: Record<string, any> = {};
let ok = 0;
for (const c of all) {
  const sym = c.yahoo ?? c.ticker;
  out[c.ticker] = {};
  for (const tf of TIMEFRAMES) {
    try {
      out[c.ticker][tf.id] = withIndicators(await series(sym, tf.interval, tf.range), tf.bars);
    } catch {
      out[c.ticker][tf.id] = null;   // intraday is unavailable for some symbols
    }
  }
  if (Object.values(out[c.ticker]).some(Boolean)) ok++;
  if (ok % 10 === 0) console.error(`  ...${ok}/${all.length}`);
}

writeJSON(`${ROOT}data/charts.json`, { updated: new Date().toISOString(), timeframes: TIMEFRAMES, charts: out });
console.log(`charts: ${ok}/${all.length} stocks x ${TIMEFRAMES.length} timeframes`);
