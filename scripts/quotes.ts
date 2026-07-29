// Live quotes + chart data for the current watchlist -> data/quotes.json
// Everything the detail pages need is captured here so render.ts stays offline.
// Usage: node scripts/quotes.ts
import { bars, quoteMeta, sma, rsi, regime, readJSON, writeJSON, ROOT, lsJSON } from './lib.ts';

const BARS = 70; // trading days kept for the candlestick chart

const latest = lsJSON(`${ROOT}data/candidates`).pop();
if (!latest) { console.log('no candidates yet — run `npm run screen`'); process.exit(0); }

const { candidates } = readJSON<any>(`${ROOT}data/candidates/${latest}`, { candidates: [] });

// HK-listed names carry price data only: HKEX publishes no structured filings API,
// so insider and 8-K signals remain US-only. Marked market:'HK' so the UI can say so.
const hk = readJSON<any>(`${ROOT}data/universe-hk.json`, { constituents: [] }).constituents
  .map((c: any) => ({ ...c, buyCount: 0, purchases: [], count8k35: 0, ratio: 0, score: 0 }));
candidates.push(...hk);
const quotes: any[] = [];

const r = (x: number | null | undefined, dp = 2) =>
  x == null || !isFinite(x) ? null : Number(x.toFixed(dp));

for (const c of candidates) {
  const base = {
    ticker: c.ticker, name: c.name, sector: c.sector, cik: c.cik, market: c.market ?? 'US',
    buyers: c.buyCount ?? 0, purchases: c.purchases ?? [],
    count8k35: c.count8k35 ?? 0, ratio8k: c.ratio ?? 0, score: c.score ?? 0,
  };
  try {
    const b = await bars(c.yahoo ?? c.ticker, '1y');
    const meta = await quoteMeta(c.yahoo ?? c.ticker);
    // range=1y omits today's in-progress bar, so the last daily close can be a
    // full session stale while the market is open. meta carries the live price.
    const lastBar = b.at(-1)!;
    const liveDate = meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : null;
    const isLive = meta.regularMarketPrice != null && liveDate != null && liveDate >= lastBar.date;
    const last = isLive
      ? { ...lastBar, date: liveDate!, close: meta.regularMarketPrice as number }
      : lastBar;
    // Compare against the previous session, never against the same bar twice.
    const prev = (isLive && liveDate === lastBar.date ? b.at(-2) : lastBar) ?? lastBar;
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
      open: r(isLive ? (meta.regularMarketOpen ?? last.open) : last.open),
      dayHigh: r(isLive ? (meta.regularMarketDayHigh ?? last.high) : last.high),
      dayLow: r(isLive ? (meta.regularMarketDayLow ?? last.low) : last.low),
      volume: isLive ? (meta.regularMarketVolume ?? last.volume) : last.volume,
      live: isLive,
      // Day range as a percentage of the previous close.
      amplitude: r((((isLive ? (meta.regularMarketDayHigh ?? last.high) : last.high)
        - (isLive ? (meta.regularMarketDayLow ?? last.low) : last.low)) / prev.close) * 100),
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
      regime: regime(last.close, ma5.at(-1) ?? null, ma20.at(-1) ?? null),
      bars: recent.map((x) => ({
        d: x.date, o: r(x.open), h: r(x.high), l: r(x.low), c: r(x.close), v: x.volume,
      })),
      maSeries: {
        ma5: ma5.slice(-BARS).map((v) => r(v)),
        ma10: ma10.slice(-BARS).map((v) => r(v)),
        ma20: ma20.slice(-BARS).map((v) => r(v)),
      },
      spark: [...closes.slice(-40), ...(isLive && liveDate !== lastBar.date ? [last.close] : [])].map((v) => r(v)),
    });
  } catch (err) {
    console.error(`  ! ${c.ticker}: ${(err as Error).message}`);
    quotes.push({ ...base, last: null, changePct: null, bars: [], spark: [] });
  }
}

// Market indices for the header strip. Same fetch path as everything else.
const INDICES = [
  ['^GSPC', 'S&P 500', 'US'], ['^IXIC', 'Nasdaq', 'US'], ['^DJI', 'Dow Jones', 'US'],
  ['^HSI', 'Hang Seng', 'HK'], ['^HSCE', 'HS China Ent', 'HK'], ['000001.SS', 'Shanghai', 'CN'],
];
const indices: any[] = [];
for (const [sym, name, market] of INDICES) {
  try {
    const b = await bars(sym, '3mo');
    const m = await quoteMeta(sym);
    const lastBar = b.at(-1)!;
    const liveDate = m.regularMarketTime
      ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10) : null;
    const isLive = m.regularMarketPrice != null && liveDate != null && liveDate >= lastBar.date;
    const price = isLive ? m.regularMarketPrice : lastBar.close;
    const prev = (isLive && liveDate === lastBar.date ? b.at(-2) : lastBar) ?? lastBar;
    indices.push({
      symbol: sym, name, market, currency: m.currency ?? '',
      last: r(price), changePct: r(((price - prev.close) / prev.close) * 100),
      spark: b.slice(-30).map((x) => r(x.close)),
    });
  } catch { /* an index that fails must not block the run */ }
}
console.log(`indices: ${indices.length}/${INDICES.length}`);

writeJSON(`${ROOT}data/quotes.json`, { updated: new Date().toISOString(), source: latest, indices, quotes });
console.log(`quotes: ${quotes.filter((q) => q.last != null).length}/${quotes.length} priced, ${BARS}-bar charts`);
