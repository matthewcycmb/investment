// Live quotes for the current candidate watchlist -> data/quotes.json
// Usage: node scripts/quotes.ts
import { bars, readJSON, writeJSON, ROOT, lsJSON } from './lib.ts';

const latest = lsJSON(`${ROOT}data/candidates`).pop();
if (!latest) { console.log('no candidates yet — run `npm run screen`'); process.exit(0); }

const { candidates } = readJSON<any>(`${ROOT}data/candidates/${latest}`, { candidates: [] });
const quotes: any[] = [];

for (const c of candidates) {
  try {
    const b = await bars(c.yahoo ?? c.ticker, '3mo');
    const last = b.at(-1)!, prev = b.at(-2) ?? last;
    quotes.push({
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      last: Number(last.close.toFixed(2)),
      asOf: last.date,
      changePct: Number((((last.close - prev.close) / prev.close) * 100).toFixed(2)),
      spark: b.slice(-40).map((x) => Number(x.close.toFixed(2))),
      buyers: c.buyCount ?? 0,
      score: c.score ?? 0,
    });
  } catch {
    quotes.push({ ticker: c.ticker, name: c.name, sector: c.sector, last: null, changePct: null, spark: [], buyers: c.buyCount ?? 0, score: c.score ?? 0 });
  }
}

writeJSON(`${ROOT}data/quotes.json`, { updated: new Date().toISOString(), source: latest, quotes });
console.log(`quotes: ${quotes.filter((q) => q.last != null).length}/${quotes.length} priced`);
