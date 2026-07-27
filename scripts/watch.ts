// Live event watcher. Runs every 5 minutes: poll four sources, keep what is
// material, and when something qualifies send it to the council and auto-open
// simulated positions.
//
// IMPORTANT: live picks are written to data/live/ and are NEVER counted by the
// pre-registered study in data/picks/. Mixing them would invalidate the study.
//
// Usage: node scripts/watch.ts [--dry] [--force]
import { get, secText, bars, readJSON, writeJSON, ROOT, lsJSON } from './lib.ts';
import { runArms, aggregate, disagreementRate, ARMS } from './arms.ts';

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force'); // demo aid: run the council even if nothing new
const NOW = new Date().toISOString();

const LIVE_HORIZON = 5;                       // trading days for live positions
const MIN_VOTES = 2;                          // council majority required to auto-invest
const MIN_CONFIDENCE = 7;                     // mean confidence required to auto-invest
const MAX_COUNCIL_RUNS_PER_DAY = Number(process.env.MAX_COUNCIL_RUNS_PER_DAY ?? 12);
const MAX_TICKERS_POLLED = 12;                // bounds headline + price-shock polling per cycle
const SHOCK_PCT = 3;                          // |move| that counts as a price shock

// Deterministic materiality gates. Fixed lists, applied before any tokens are spent.
const POLICY_TYPES = ['Rule', 'Presidential Document', 'Proposed Rule'];
const SECTOR_KEYWORDS: Record<string, string[]> = {
  'Information Technology': ['semiconductor', 'chip', 'software', 'data privacy', 'artificial intelligence', 'export control'],
  'Health Care': ['drug', 'pharmaceutical', 'medicare', 'medicaid', 'fda', 'health insurance', 'clinical'],
  Energy: ['oil', 'gas', 'pipeline', 'drilling', 'emission', 'renewable', 'petroleum'],
  Financials: ['bank', 'capital requirement', 'securities', 'lending', 'credit', 'basel', 'insurance'],
  Industrials: ['tariff', 'trade', 'infrastructure', 'aviation', 'rail', 'freight', 'defense'],
  'Consumer Discretionary': ['tariff', 'import', 'consumer product', 'vehicle', 'automobile'],
  'Consumer Staples': ['food', 'agriculture', 'labeling', 'tobacco', 'beverage'],
  Materials: ['mining', 'chemical', 'steel', 'aluminum', 'tariff'],
  Utilities: ['electricity', 'power plant', 'grid', 'nuclear', 'emission'],
  'Real Estate': ['housing', 'mortgage', 'zoning', 'real estate'],
  'Communication Services': ['telecom', 'broadband', 'spectrum', 'media', 'antitrust'],
};
const HEADLINE_KEYWORDS = [
  'acquisition', 'acquire', 'merger', 'buyout', 'takeover', 'bankruptcy', 'lawsuit', 'investigation',
  'recall', 'guidance', 'downgrade', 'upgrade', 'fda approval', 'earnings beat', 'earnings miss',
  'ceo', 'resign', 'layoff', 'settlement', 'antitrust', 'probe', 'warning',
];

type Event = {
  id: string; ts: string; source: 'policy' | 'filing' | 'headline' | 'shock';
  title: string; url?: string; tickers: string[]; detail?: string;
};

const universe = readJSON<{ constituents: any[] }>(`${ROOT}data/universe.json`, { constituents: [] });
const byCik = new Map(universe.constituents.map((c) => [String(Number(c.cik)), c]));
const byTicker = new Map(universe.constituents.map((c) => [c.ticker, c]));

const STATE_PATH = `${ROOT}data/watch-state.json`;
const state = readJSON<{ seen: string[]; councilRuns: Record<string, number>; cursor: number }>(
  STATE_PATH, { seen: [], councilRuns: {}, cursor: 0 },
);
const seen = new Set(state.seen);
const today = NOW.slice(0, 10);
const runsToday = state.councilRuns[today] ?? 0;

const found: Event[] = [];
const note = (m: string) => console.error(`  ${m}`);

// ---------- 1. policy: Federal Register ----------
try {
  const url = 'https://www.federalregister.gov/api/v1/documents.json?per_page=40&order=newest'
    + '&fields[]=document_number&fields[]=title&fields[]=type&fields[]=agencies&fields[]=html_url&fields[]=publication_date';
  const docs = (await (await get(url, { key: 'fedreg' })).json()).results ?? [];
  for (const d of docs) {
    const id = `policy:${d.document_number}`;
    if (seen.has(id) || !POLICY_TYPES.includes(d.type)) continue;
    const text = `${d.title} ${(d.agencies ?? []).map((a: any) => a.name).join(' ')}`.toLowerCase();
    const sectors = Object.entries(SECTOR_KEYWORDS)
      .filter(([, kws]) => kws.some((k) => text.includes(k)))
      .map(([s]) => s);
    if (!sectors.length) continue; // no economic read-through — not material
    const tickers = universe.constituents.filter((c) => sectors.includes(c.sector)).map((c) => c.ticker);
    found.push({
      id, ts: d.publication_date, source: 'policy', title: d.title, url: d.html_url,
      tickers: tickers.slice(0, 60),
      detail: `${d.type} · ${(d.agencies ?? []).map((a: any) => a.name).join(', ')} · sectors: ${sectors.join(', ')}`,
    });
  }
  note(`policy: ${docs.length} checked`);
} catch (e) { note(`! policy source failed: ${(e as Error).message}`); }

// ---------- 2. filings: EDGAR live 8-K feed ----------
try {
  const atom = await secText(
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=100&output=atom',
  );
  let n = 0;
  for (const [, title] of atom.matchAll(/<title>8-K[^<]*\((\d{7,10})\)[^<]*<\/title>/g)) {
    n++;
    const c = byCik.get(String(Number(title)));
    if (!c) continue; // not an S&P 500 constituent
    const id = `filing:${c.ticker}:${title}`;
    if (seen.has(id)) continue;
    found.push({
      id, ts: NOW, source: 'filing', title: `${c.name} filed an 8-K (material corporate event)`,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.cik}&type=8-K`,
      tickers: [c.ticker], detail: `${c.ticker} · ${c.sector}`,
    });
  }
  note(`filings: ${n} 8-Ks checked`);
} catch (e) { note(`! filing source failed: ${(e as Error).message}`); }

// ---------- 3 & 4. headlines and price shocks, over a bounded rotating ticker set ----------
// Open positions are always watched; the rest of the budget rotates through candidates.
const watchTickers: string[] = [...new Set<string>(
  readJSON<any>(`${ROOT}data/outcomes.json`, { positions: [] }).positions
    .filter((p: any) => p.status === 'open').map((p: any) => p.ticker),
)];

{
  const latest = lsJSON(`${ROOT}data/candidates`).pop();
  const cands: string[] = latest
    ? readJSON<any>(`${ROOT}data/candidates/${latest}`, { candidates: [] }).candidates.map((c: any) => c.ticker)
    : [];
  const pool = [...new Set([...watchTickers, ...cands])];
  const start = state.cursor % Math.max(1, pool.length);
  const rotated = [...pool.slice(start), ...pool.slice(0, start)].slice(0, MAX_TICKERS_POLLED);
  state.cursor = start + rotated.length;

  for (const t of rotated) {
    const c = byTicker.get(t);
    // headlines
    try {
      const rss = await (await get(
        `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(t)}&region=US&lang=en-US`,
        { key: 'yahoo', minGapMs: 220, headers: { 'User-Agent': 'Mozilla/5.0' } },
      )).text();
      const items = [...rss.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/g)];
      for (const [, rawTitle, link] of items.slice(0, 8)) {
        const title = rawTitle.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const hit = HEADLINE_KEYWORDS.find((k) => title.toLowerCase().includes(k));
        if (!hit) continue;
        const id = `headline:${t}:${title.slice(0, 60)}`;
        if (seen.has(id)) continue;
        found.push({ id, ts: NOW, source: 'headline', title, url: link.trim(), tickers: [t], detail: `${t} · matched "${hit}"` });
      }
    } catch { /* RSS is flaky by nature; never let it stop the cycle */ }

    // price shocks
    try {
      const b = await bars(c?.yahoo ?? t, '1mo');
      if (b.length >= 2) {
        const last = b.at(-1)!, prev = b.at(-2)!;
        const move = ((last.close - prev.close) / prev.close) * 100;
        if (Math.abs(move) >= SHOCK_PCT) {
          const id = `shock:${t}:${last.date}`;
          if (!seen.has(id)) {
            found.push({
              id, ts: NOW, source: 'shock',
              title: `${t} moved ${move >= 0 ? '+' : ''}${move.toFixed(1)}% on ${last.date}`,
              tickers: [t], detail: `close ${prev.close.toFixed(2)} → ${last.close.toFixed(2)}`,
            });
          }
        }
      }
    } catch { /* missing series must not stop the cycle */ }
  }
  note(`polled ${rotated.length} tickers for headlines + shocks`);
}

// ---------- record events ----------

const eventsPath = `${ROOT}data/events.json`;
const log = readJSON<{ events: Event[] }>(eventsPath, { events: [] });
for (const e of found) { seen.add(e.id); log.events.unshift(e); }
log.events = log.events.slice(0, 300); // rolling window for the dashboard feed

console.log(`\n${NOW} — ${found.length} new material event(s)`);
for (const e of found.slice(0, 10)) console.log(`  [${e.source}] ${e.title.slice(0, 100)}`);

// ---------- council + auto-invest ----------

let invested: any = null;

if (!found.length && !FORCE) {
  console.log('nothing material — council not called, no tokens spent');
} else if (runsToday >= MAX_COUNCIL_RUNS_PER_DAY && !FORCE) {
  console.log(`daily council budget reached (${runsToday}/${MAX_COUNCIL_RUNS_PER_DAY}) — skipping`);
} else if (!process.env.AI_GATEWAY_API_KEY) {
  console.log('AI_GATEWAY_API_KEY not set — events recorded, council skipped');
} else {
  const tickers = [...new Set(found.flatMap((e) => e.tickers))].slice(0, 60);
  const pool = tickers.length ? tickers : [...byTicker.keys()].slice(0, 40);

  const priced: string[] = [];
  for (const t of pool.slice(0, 25)) {
    try {
      const b = await bars(byTicker.get(t)?.yahoo ?? t, '3mo');
      const last = b.at(-1)!, prev = b.at(-2) ?? last;
      priced.push(`${t} — ${byTicker.get(t)?.name ?? t} (${byTicker.get(t)?.sector ?? '?'}) · last ${last.close.toFixed(2)} · 1d ${(((last.close - prev.close) / prev.close) * 100).toFixed(1)}%`);
    } catch { priced.push(`${t} — ${byTicker.get(t)?.name ?? t} (price unavailable)`); }
  }

  const BRIEF = `Breaking events just occurred. Decide whether any warrant buying US equities RIGHT NOW.

RULES:
- Horizon is ${LIVE_HORIZON} trading days. Entry is the next session's open; exit is the open ${LIVE_HORIZON} sessions later.
- Equal weight. No stop-losses, no early exits.
- You are measured against SPY over the same window. A stock that rises less than SPY is a loss.
- Only name tickers from the allowed list below.
- If nothing here is a genuine opportunity, return an EMPTY list. Doing nothing is a valid and
  often correct answer. Do not invent a trade to look useful.

EVENTS (${found.length}):
${found.slice(0, 25).map((e) => `- [${e.source}] ${e.title}${e.detail ? `\n    ${e.detail}` : ''}`).join('\n')}

ALLOWED TICKERS:
${priced.join('\n')}

Return only names where the event above is a specific, tradeable catalyst within ${LIVE_HORIZON} days.
Give an honest 1-10 confidence. Positions are only opened when the council agrees (${MIN_VOTES}+ votes)
and mean confidence is at least ${MIN_CONFIDENCE}.`;

  const valid = new Set(pool.map((t) => t.toUpperCase()));
  const armResults = await runArms(BRIEF, valid);
  const live = armResults.filter((a) => a.ok);
  state.councilRuns[today] = runsToday + 1;

  if (live.length < 2) {
    console.log(`only ${live.length} arm(s) responded — no auto-investment`);
  } else {
    const council = aggregate(live);
    // Pre-declared auto-invest gate.
    const qualifying = council.filter((p) => p.votes >= MIN_VOTES && p.meanConfidence >= MIN_CONFIDENCE);
    console.log(`\ncouncil returned ${council.length} name(s); ${qualifying.length} passed the auto-invest gate`);
    if (council.length) {
      console.table(council.map((c) => ({
        ticker: c.ticker, votes: c.votes, conf: c.meanConfidence,
        invest: c.votes >= MIN_VOTES && c.meanConfidence >= MIN_CONFIDENCE ? 'YES' : 'no',
      })));
    }

    invested = {
      date: today, ts: NOW, study: false,
      horizonTradingDays: LIVE_HORIZON,
      trigger: found.slice(0, 25).map((e) => ({ source: e.source, title: e.title, url: e.url })),
      gate: { minVotes: MIN_VOTES, minConfidence: MIN_CONFIDENCE },
      arms: armResults.map((a) => ({ id: a.id, model: a.model, ok: a.ok, error: a.error ?? null, latencyMs: a.latencyMs, picks: a.picks })),
      councilAll: council,
      council: qualifying.map((p, i) => ({ ...p, rank: i + 1 })),
      exploratory: { disagreementRate: disagreementRate(live), armsLive: live.length },
    };
  }
}

// ---------- persist ----------

if (DRY) {
  console.log('\n--dry: nothing written');
} else {
  writeJSON(eventsPath, log);
  state.seen = [...seen].slice(-5000);
  writeJSON(STATE_PATH, state);
  if (invested?.council?.length) {
    const stamp = NOW.replace(/[:.]/g, '-').slice(0, 19);
    writeJSON(`${ROOT}data/live/${stamp}.json`, invested);
    console.log(`\nAUTO-INVESTED: ${invested.council.map((p: any) => p.ticker).join(', ')} -> data/live/${stamp}.json`);
  } else if (invested) {
    console.log('\ncouncil found no qualifying opportunity — no position opened (this is a valid outcome)');
  }
}
