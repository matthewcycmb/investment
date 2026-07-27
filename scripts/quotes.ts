// Live quotes + chart data for the current watchlist -> data/quotes.json
// Everything the detail pages need is captured here so render.ts stays offline.
// Usage: node scripts/quotes.ts
import { bars, quoteMeta, sma, rsi, readJSON, writeJSON, ROOT, lsJSON } from './lib.ts';

const BARS = 70; // trading days kept for the candlestick chart

const latest = lsJSON(`${ROOT}data/candidates`).pop();
if (!latest) { console.log('no candidates yet — run `npm run screen`'); process.exit(0); }

const { candidates } = readJSON<any>(`${ROOT}data/candidates/${latest}`, { candidates: [] });
const quotes: any[] = [];

const r = (x: number | null | undefined, dp = 2) =>
  x == null || !isFinite(x) ? null : Number(x.toFixed(dp));

for (const c of candidates) {
  const base = {
    ticker: c.ticker, name: c.name, sector: c.sector, cik: c.cik,
    buyers: c.buyCount ?? 0, purchases: c.purchases ?? [],
    count8k35: c.count8k35 ?? 0, ratio8k: c.ratio ?? 0, score: c.score ?? 0,
  };
  try {
    const b = await bars(c.yahoo ?? c.ticker, '1y');
    const meta = await quoteMeta(c.yahoo ?? c.ticker);
    const last = b.at(-1)!, prev = b.at(-2) ?? last;
    const closes = b.map((x) => x.close);
    const back = (n: number) => closes[Math.max(0, closes.length - 1 - n)];
    const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20);
    const rs = rsi(closes);
    const recent = b.slice(-BARS);

    quotes.push({
      ...base,
      last: r(last.close), asOf: last.date,
      prevClose: r(prev.close),
      changePct: r(((last.close - prev.close) / prev.close) * 100),
      open: r(last.open), dayHigh: r(last.high), dayLow: r(last.low),
      volume: last.volume,
      // Day range as a percentage of the previous close.
      amplitude: r(((last.high - last.low) / prev.close) * 100),
      w52High: r(meta.fiftyTwoWeekHigh), w52Low: r(meta.fiftyTwoWeekLow),
      // Where the price sits inside its 52-week range, 0 = low, 100 = high.
      rangePos: meta.fiftyTwoWeekHigh && meta.fiftyTwoWeekLow
        ? r(((last.close - meta.fiftyTwoWeekLow) / (meta.fiftyTwoWeekHigh - meta.fiftyTwoWeekLow)) * 100, 1)
        : null,
      avg30: r(closes.slice(-30).reduce((a, x) => a + x, 0) / Math.min(30, closes.length)),
      ret1m: r(((last.close - back(21)) / back(21)) * 100),
      ret3m: r(((last.close - back(63)) / back(63)) * 100),
      ret1y: r(((last.close - closes[0]) / closes[0]) * 100),
      ma5: r(ma5.at(-1)), ma10: r(ma10.at(-1)), ma20: r(ma20.at(-1)),
      rsi14: r(rs.at(-1), 1),
      bars: recent.map((x) => ({
        d: x.date, o: r(x.open), h: r(x.high), l: r(x.low), c: r(x.close), v: x.volume,
      })),
      maSeries: {
        ma5: ma5.slice(-BARS).map((v) => r(v)),
        ma10: ma10.slice(-BARS).map((v) => r(v)),
        ma20: ma20.slice(-BARS).map((v) => r(v)),
      },
      spark: closes.slice(-40).map((v) => r(v)),
    });
  } catch (err) {
    console.error(`  ! ${c.ticker}: ${(err as Error).message}`);
    quotes.push({ ...base, last: null, changePct: null, bars: [], spark: [] });
  }
}

writeJSON(`${ROOT}data/quotes.json`, { updated: new Date().toISOString(), source: latest, quotes });
console.log(`quotes: ${quotes.filter((q) => q.last != null).length}/${quotes.length} priced, ${BARS}-bar charts`);
