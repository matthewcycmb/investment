// Mechanical weekly screen. Implements PREREGISTRATION.md §4 exactly.
//   score = 2 * (distinct Form 4 open-market buyers, trailing 35d)
//         + min(8-K disclosure ratio, 3)
// No ticker is ever added or removed by hand.
//
// Usage: node scripts/screen.ts [--dry] [--limit N]
import { secJSON, secText, readJSON, writeJSON, ROOT } from './lib.ts';

const DRY = process.argv.includes('--dry');
const LIMIT = Number(process.argv[process.argv.indexOf('--limit') + 1]) || Infinity;
const TODAY = new Date().toISOString().slice(0, 10);
const TOP_N = 20;
const WINDOW_DAYS = 35;

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const CUTOFF_TXN = daysAgo(WINDOW_DAYS);
const CUTOFF_FILED = daysAgo(WINDOW_DAYS + 10); // Form 4 is due within 2 business days; pad for weekends
const CUTOFF_YEAR = daysAgo(365);

const CACHE_VERSION = 2; // bump whenever parseForm4's output shape changes

type Owner = { name: string; isDirector: boolean; isOfficer: boolean };
type Form4 = { symbol: string; owners: Owner[]; purchases: { date: string; shares: number; price: number }[] };

/**
 * Extract open-market purchases (transactionCode P) plus each reporting owner's
 * relationship to the issuer. The relationship flags are what separate a real
 * officer/director purchase from a corporate-entity or 10%-owner filing.
 */
function parseForm4(xml: string): Form4 {
  const symbol = (/<issuerTradingSymbol>\s*([^<\s]*)/.exec(xml)?.[1] ?? '').toUpperCase();
  const owners: Owner[] = [];
  for (const [, who] of xml.matchAll(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/g)) {
    const name = /<rptOwnerName>([^<]*)<\/rptOwnerName>/.exec(who)?.[1]?.trim().toUpperCase();
    if (!name) continue;
    const flag = (tag: string) => /^(true|1)$/i.test((new RegExp(`<${tag}>\\s*([^<]*)`).exec(who)?.[1] ?? '').trim());
    owners.push({ name, isDirector: flag('isDirector'), isOfficer: flag('isOfficer') });
  }
  const purchases: Form4['purchases'] = [];
  for (const [, block] of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const code = /<transactionCoding>[\s\S]*?<transactionCode>\s*([A-Z])\s*<\/transactionCode>/.exec(block)?.[1];
    if (code !== 'P') continue; // A=grant, M=exercise, F=tax withholding, S=sale — all excluded
    purchases.push({
      date: /<transactionDate>\s*<value>\s*([\d-]+)/.exec(block)?.[1] ?? '',
      shares: Number(/<transactionShares>\s*<value>\s*([\d.]+)/.exec(block)?.[1] ?? 0),
      price: Number(/<transactionPricePerShare>\s*<value>\s*([\d.]+)/.exec(block)?.[1] ?? 0),
    });
  }
  return { symbol, owners, purchases };
}

const universe = readJSON<{ constituents: any[] }>(`${ROOT}data/universe.json`, { constituents: [] });
if (!universe.constituents.length) throw new Error('run `npm run universe` first');

const CACHE_PATH = `${ROOT}data/form4-cache.json`;
const cacheFile = readJSON<{ version?: number; forms?: Record<string, Form4> }>(CACHE_PATH, {});
// A parser change invalidates every cached parse; refetch rather than mix shapes.
const cache: Record<string, Form4> = cacheFile.version === CACHE_VERSION ? (cacheFile.forms ?? {}) : {};
if (cacheFile.version !== undefined && cacheFile.version !== CACHE_VERSION) {
  console.error(`  cache v${cacheFile.version} != v${CACHE_VERSION}; reparsing all filings`);
}
const cacheSizeBefore = Object.keys(cache).length;

const targets = universe.constituents.slice(0, LIMIT);
const scored: any[] = [];
let done = 0;

for (const c of targets) {
  let subs: any;
  try {
    subs = await secJSON(`https://data.sec.gov/submissions/CIK${c.cik}.json`);
  } catch (err) {
    console.error(`  ! ${c.ticker}: submissions fetch failed (${(err as Error).message}) — scored 0`);
    scored.push({ ...c, score: 0, buyers: [], buyCount: 0, purchases: [], count8k35: 0, rate35: 0, ratio: 0, error: true });
    continue;
  }
  const r = subs.filings?.recent;
  if (!r?.form) continue;

  // --- component 2: abnormal 8-K disclosure volume ---
  const dates8k = r.form.map((f: string, i: number) => (f === '8-K' ? r.filingDate[i] : null)).filter(Boolean) as string[];
  const oldest = r.filingDate[r.filingDate.length - 1] ?? TODAY;
  const spanDays = Math.max(1, Math.round((Date.parse(TODAY) - Date.parse(oldest)) / 864e5));
  const effectiveSpan = Math.min(spanDays, 365); // `recent` holds 1000 filings; may cover < 1y for heavy filers
  const count8k35 = dates8k.filter((d) => d >= CUTOFF_TXN).length;
  const count8kBase = dates8k.filter((d) => d >= CUTOFF_YEAR).length;
  const rate35 = (count8kBase * WINDOW_DAYS) / effectiveSpan;
  // Cap is pre-registered at 3, which also defines the zero-baseline case.
  const ratio = rate35 === 0 ? (count8k35 > 0 ? 3 : 0) : Math.min(count8k35 / rate35, 3);

  // --- component 1: distinct insider open-market buyers ---
  const accessions: string[] = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] === '4' && r.filingDate[i] >= CUTOFF_FILED) {
      accessions.push(`${r.accessionNumber[i]}|${r.primaryDocument[i]}`);
    }
  }
  for (const a of accessions) {
    const [acc, doc] = a.split('|');
    if (cache[acc]) continue;
    const bare = acc.replace(/-/g, '');
    const file = doc.split('/').pop(); // primaryDocument points at the XSL-rendered path
    try {
      cache[acc] = parseForm4(await secText(
        `https://www.sec.gov/Archives/edgar/data/${Number(c.cik)}/${bare}/${file}`,
      ));
    } catch {
      cache[acc] = { symbol: '', owners: [], purchases: [] }; // unparseable filing counts as no purchase
    }
  }

  const buyers = new Set<string>();
  const purchases: any[] = [];
  for (const a of accessions) {
    const f = cache[a.split('|')[0]];
    if (!f) continue;
    // Filing must cover the security being screened, not an affiliate's own shares.
    if (f.symbol && f.symbol !== c.ticker.toUpperCase()) continue;
    const recent = f.purchases.filter((p) => p.date >= CUTOFF_TXN);
    if (!recent.length) continue;
    // Officers and directors only; corporate entities and pure 10%-owners are excluded.
    const insiders = f.owners.filter((o) => o.isDirector || o.isOfficer);
    if (!insiders.length) continue;
    for (const o of insiders) buyers.add(o.name);
    for (const p of recent) purchases.push({ ...p, owners: insiders.map((o) => o.name) });
  }

  const score = 2 * buyers.size + ratio;
  scored.push({
    ticker: c.ticker, yahoo: c.yahoo, name: c.name, sector: c.sector, cik: c.cik,
    score: Number(score.toFixed(3)),
    buyCount: buyers.size,
    buyers: [...buyers],
    purchases,
    count8k35, rate35: Number(rate35.toFixed(3)), ratio: Number(ratio.toFixed(3)),
  });

  if (++done % 50 === 0) console.error(`  ...${done}/${targets.length} screened`);
}

// Eligibility gate + deterministic ordering, both pre-registered.
const eligible = scored.filter((s) => s.buyCount > 0 || s.ratio >= 1.0);
eligible.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
const candidates = eligible.slice(0, TOP_N);

console.log(`\nscreened ${scored.length} | eligible ${eligible.length} | candidates ${candidates.length}`);
console.table(candidates.map((c) => ({
  ticker: c.ticker, sector: c.sector, score: c.score, buyers: c.buyCount, '8K35': c.count8k35, ratio: c.ratio,
})));

if (DRY) {
  console.log('\n--dry: nothing written');
} else {
  if (Object.keys(cache).length !== cacheSizeBefore) writeJSON(CACHE_PATH, { version: CACHE_VERSION, forms: cache });
  writeJSON(`${ROOT}data/candidates/${TODAY}.json`, {
    date: TODAY,
    rule: 'PREREGISTRATION.md §4: score = 2*distinct_form4_P_buyers(35d) + min(8K_ratio, 3)',
    universeSnapshot: (universe as any).snapshotDate,
    screened: scored.length,
    eligible: eligible.length,
    candidates,
  });
  console.log(`wrote data/candidates/${TODAY}.json`);
}
