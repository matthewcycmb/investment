// Live event watcher. Runs every 5 minutes: poll four sources, keep what is
// material, and when something qualifies send it to the council and auto-open
// simulated positions.
//
// IMPORTANT: live picks are written to data/live/ and are NEVER counted by the
// pre-registered study in data/picks/. Mixing them would invalidate the study.
//
// Usage: node scripts/watch.ts [--dry] [--force]
import { get, secText, bars, readJSON, writeJSON, ROOT, lsJSON, notify } from './lib.ts';
import { convene, disagreementRate, ARMS, FALLBACK, ACT_MIN_AGREEMENT, ACT_MIN_VOTES } from './arms.ts';

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force'); // demo aid: run the council even if nothing new
const NOW = new Date().toISOString();

const LIVE_HORIZON = 5;                       // trading days for live positions
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


/** 9.01 is exhibits; 7.01/8.01 alone are routine. An 8-K of only these says nothing. */
const BOILERPLATE_8K = new Set(['9.01', '7.01', '8.01']);

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

/** RSS fields arrive XML-escaped; decode once so the renderer does not double-escape them. */
const decodeEntities = (t: string): string => String(t).replace(
  /&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g,
  (m, e) => {
    const k = String(e).toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  },
);

const eventsPath = `${ROOT}data/events.json`;
const log = readJSON<{ events: Event[] }>(eventsPath, { events: [] });
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
  const entries = [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  for (const entry of entries) {
    const cikStr = /<title>8-K[^<]*\((\d{7,10})\)/.exec(entry)?.[1];
    if (!cikStr) continue;
    n++;
    const c = byCik.get(String(Number(cikStr)));
    if (!c) continue; // not an S&P 500 constituent

    // EDGAR's summary already spells out what the filing reported, HTML-escaped.
    const summary = decodeEntities(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(entry)?.[1] ?? '');
    const acc = /AccNo:\s*([\d-]+)/.exec(summary)?.[1] ?? '';
    const items = [...summary.matchAll(/Item\s+(\d+\.\d+):\s*([^<\n]+)/g)]
      .map((m) => ({ code: m[1], text: m[2].replace(/\s+/g, ' ').trim().replace(/[;,]\s*$/, '') }));
    const meaningful = items.filter((i) => !BOILERPLATE_8K.has(i.code));
    if (items.length && !meaningful.length) continue; // exhibits or routine disclosure only

    const id = `filing:${c.ticker}:${acc || cikStr}`;
    if (seen.has(id)) continue;

    const what = meaningful.map((i) => i.text).join('; ').slice(0, 220);
    found.push({
      id, ts: NOW, source: 'filing',
      title: what ? `${c.name}: ${what}` : `${c.name} filed an 8-K`,
      url: /<link[^>]*href="([^"]+)"/.exec(entry)?.[1]
        ?? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.cik}&type=8-K`,
      tickers: [c.ticker],
      detail: `${c.ticker} · ${c.sector}${meaningful.length ? ` · SEC 8-K item ${meaningful.map((i) => i.code).join(', ')}` : ''}`,
    });
  }
  note(`filings: ${n} 8-Ks checked`);
} catch (e) { note(`! filing source failed: ${(e as Error).message}`); }

// ---------- 2b. insider dealing: officers and directors buying their own stock ----------
// The screen already parsed these from Form 4; surface them as signals rather
// than refetching anything.
{
  const latest = lsJSON(`${ROOT}data/candidates`).pop();
  const cands = latest
    ? readJSON<any>(`${ROOT}data/candidates/${latest}`, { candidates: [] }).candidates
    : [];
  let n = 0;
  for (const c of cands) {
    for (const p of c.purchases ?? []) {
      const who = (p.owners ?? [])[0] ?? 'An insider';
      // Signal threshold only. The screen's insider count is unchanged, so the
      // pre-registered study is unaffected; this stops a US$224 purchase being
      // presented as a signal and triggering a council run.
      const usd = (p.price ?? 0) * (p.shares ?? 0);
      if (usd < 25_000) continue;
      const id = `insider:${c.ticker}:${who}:${p.date}:${p.shares}`;
      if (seen.has(id)) continue;
      n++;
      const value = p.price ? ` (US$${Math.round(p.shares * p.price).toLocaleString()})` : '';
      found.push({
        id, ts: p.date, source: 'insider',
        title: `${who} bought ${Number(p.shares).toLocaleString()} ${c.ticker} shares`
          + (p.price ? ` at $${Number(p.price).toFixed(2)}` : '') + value,
        url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.cik}&type=4`,
        tickers: [c.ticker],
        detail: `${c.ticker} · officer or director open-market purchase · SEC Form 4`,
      });
    }
  }
  note(`insider: ${n} new Form 4 purchase(s)`);
}

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
        const title = decodeEntities(rawTitle.replace(/<!\[CDATA\[|\]\]>/g, '').trim());
        const hit = HEADLINE_KEYWORDS.find((k) => title.toLowerCase().includes(k));
        if (!hit) continue;
        // A ticker's RSS feed returns sector stories about other companies. Only tag
        // the headline to this ticker if it actually names it; otherwise it is a
        // keyword collision and the models correctly refuse to act on it.
        const firstWord = String(c?.name ?? '').split(/[\s,.]+/)[0];
        const namesIt = new RegExp(`\\b${t}\\b`, 'i').test(title)
          || (firstWord.length > 3 && title.toLowerCase().includes(firstWord.toLowerCase()));
        if (!namesIt) continue;
        const id = `headline:${t}:${title.slice(0, 60)}`;
        if (seen.has(id)) continue;
        found.push({ id, ts: NOW, source: 'headline', title, url: decodeEntities(link.trim()), tickers: [t], detail: `${t} · matched "${hit}"` });
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
            // A bare price move gives the council nothing to judge. Attach any
            // headline already seen for this ticker so the move has a candidate cause.
            const context = [...found, ...log.events]
              .filter((e: any) => e.source === 'headline' && (e.tickers ?? []).includes(t))
              .slice(0, 2).map((e: any) => e.title);
            const headline = `${t} moved ${move >= 0 ? '+' : ''}${move.toFixed(1)}% on ${last.date}`
              + (context.length ? `· possible cause: ${context.join(' | ')}` : '· no reported cause');
            notify(`Price alert: ${t}`, `${headline} (${prev.close.toFixed(2)} → ${last.close.toFixed(2)})`);
            found.push({
              id, ts: NOW, source: 'shock', title: headline,
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
  // --force with nothing new re-examines the most recent real signals, so the demo
  // button always has genuine material rather than an empty event list.
  const review = found.length ? found : log.events.slice(0, 12);
  // Cap the review set: every extra ticker lengthens all four responses, and long
  // generations hit the gateway's stream limit and kill specialists mid-run.
  const MAX_REVIEW_TICKERS = 8;
  const tickers = [...new Set(review.flatMap((e: any) => e.tickers ?? []))].slice(0, MAX_REVIEW_TICKERS);
  // With --force and no new events, fall back to the current screened watchlist
  // rather than an arbitrary slice of the universe.
  const latestCand = lsJSON(`${ROOT}data/candidates`).pop();
  const watchlist: string[] = latestCand
    ? readJSON<any>(`${ROOT}data/candidates/${latestCand}`, { candidates: [] }).candidates.map((c: any) => c.ticker)
    : [];
  const pool = tickers.length ? tickers : watchlist.slice(0, MAX_REVIEW_TICKERS);

  const priced: string[] = [];
  for (const t of pool) {
    try {
      const b = await bars(byTicker.get(t)?.yahoo ?? t, '3mo');
      const last = b.at(-1)!, prev = b.at(-2) ?? last;
      priced.push(`${t} — ${byTicker.get(t)?.name ?? t} (${byTicker.get(t)?.sector ?? '?'}) · last ${last.close.toFixed(2)} · 1d ${(((last.close - prev.close) / prev.close) * 100).toFixed(1)}%`);
    } catch { priced.push(`${t} — ${byTicker.get(t)?.name ?? t} (price unavailable)`); }
  }

  const BRIEF = `Breaking events just occurred. Give your specialist verdict on the affected stocks.

RULES:
- Horizon is ${LIVE_HORIZON} trading days. Entry is the next session's open; exit is the open ${LIVE_HORIZON} sessions later.
- Equal weight. No stop-losses, no early exits.
- Measured against SPY over the same window. A stock that rises less than SPY is a loss.
- Only name tickers from the allowed list below.
- Verdict is BUY, SELL or HOLD. All three are real answers.
  Do not invent a trade to look useful, and do not default to HOLD to look cautious.
  Return an EMPTY findings array only if the material genuinely supports no view at all.
- Every claim you put in "evidence" must come from the material below, not from memory.
- "risk" must be the strongest argument AGAINST your own verdict.

EVENTS (${review.length}):
${review.slice(0, 25).map((e) => `- [${e.source}] ${e.title}${e.detail ? `\n    ${e.detail}` : ''}`).join('\n')}

ALLOWED TICKERS:
${priced.join('\n')}`;

  notify(
    'Council deciding now',
    `${review.length} event(s) -> ${ARMS.length} specialists reviewing ${pool.length} ticker(s). No trade placed yet.`,
  );

  // Event kind drives step 2 weighting: a policy specialist counts for more on policy.
  const counts = review.reduce((a: Record<string, number>, e) => ({ ...a, [e.source]: (a[e.source] ?? 0) + 1 }), {});
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const kind: any = !top.length ? 'mixed' : (top[0][1] / review.length >= 0.6 ? top[0][0] : 'mixed');

  const valid = new Set(pool.map((t) => t.toUpperCase()));
  const { results, verdicts, debated, armsLive } = await convene(BRIEF, valid, kind);
  state.councilRuns[today] = runsToday + 1;

  if (armsLive < 2) {
    console.log(`only ${armsLive} specialist(s) responded - no auto-investment`);
  } else {
    const buys = verdicts.filter((v) => v.invest);
    console.log(`\ncouncil reviewed ${verdicts.length} stock(s); ${buys.length} cleared the gate`);
    if (verdicts.length) {
      console.table(verdicts.map((v) => ({
        ticker: v.ticker, action: v.action,
        agreement: `${(v.agreement * 100).toFixed(0)}%`,
        votes: v.votes, conf: v.meanConfidence,
        debated: v.debated ? 'yes' : '', invest: v.invest ? 'YES' : '',
      })));
    }

    if (buys.length) {
      notify('AUTO-INVESTED',
        buys.map((v) => `${v.ticker} (${(v.agreement * 100).toFixed(0)}% agreement, conf ${v.meanConfidence})`).join(', '));
    } else {
      notify('Council decided: no trade',
        `Reviewed ${review.length} event(s). Nothing reached ${Math.round(ACT_MIN_AGREEMENT * 100)}% agreement on BUY.`);
    }

    invested = {
      date: today, ts: NOW, study: false,
      eventKind: kind, fallback: FALLBACK,
      horizonTradingDays: LIVE_HORIZON,
      trigger: review.slice(0, 25).map((e) => ({ source: e.source, title: e.title, url: e.url })),
      rubric: {
        steps: ['verify evidence', 'weight votes', 'measure agreement', 'investigate credible disagreement'],
        actMinAgreement: ACT_MIN_AGREEMENT, actMinVotes: ACT_MIN_VOTES,
      },
      debatedTickers: debated,
      specialists: results.map((r) => ({
        id: r.id, model: r.model, name: r.name, specialty: r.specialty,
        ok: r.ok, error: r.error ?? null, latencyMs: r.latencyMs, revised: r.revised ?? false,
        usage: r.usage ?? null,
        findings: r.findings,
      })),
      verdicts,
      council: buys.map((v, i) => ({ ticker: v.ticker, rank: i + 1, votes: v.votes,
        agreement: v.agreement, meanConfidence: v.meanConfidence })),
      exploratory: { disagreementRate: disagreementRate(results), armsLive },
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
  // Every session that reached a verdict is recorded, including sessions that
  // decided NOT to trade. A council that declines is a result, not a non-event,
  // and dropping those would leave only the trades on the public record.
  if (invested) {
    const stamp = NOW.replace(/[:.]/g, '-').slice(0, 19);
    writeJSON(`${ROOT}data/live/${stamp}.json`, invested);
    if (invested.council?.length) {
      console.log(`\nAUTO-INVESTED: ${invested.council.map((p: any) => p.ticker).join(', ')} -> data/live/${stamp}.json`);
    } else {
      console.log(`\nno qualifying opportunity — session recorded, no position opened -> data/live/${stamp}.json`);
    }
  }
}
