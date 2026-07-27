// Resolves picks into outcomes. Entry = open of the first session AFTER the pick
// was committed; exit = open 10 sessions later. Excess return is measured against
// SPY over the identical two sessions (PREREGISTRATION.md §4).
//
// Usage: node scripts/settle.ts [--selfcheck]
import { bars, readJSON, writeJSON, ROOT, weekKey, lsJSON, type Bar } from './lib.ts';

const HORIZON = 10;

export type Resolved =
  | { status: 'pending' }
  | { status: 'open'; entryDate: string; entryPrice: number; markDate: string; markPrice: number }
  | { status: 'closed'; entryDate: string; entryPrice: number; exitDate: string; exitPrice: number };

/**
 * Locate entry/exit bars for a pick. Uses the bar series itself as the trading
 * calendar, so market holidays need no special handling.
 */
export function resolve(series: Bar[], pickDate: string, horizon = HORIZON): Resolved {
  const i = series.findIndex((b) => b.date > pickDate);
  if (i === -1) return { status: 'pending' }; // no session has opened since the pick
  const entry = series[i];
  const exit = series[i + horizon];
  if (!exit) {
    const mark = series.at(-1)!;
    return { status: 'open', entryDate: entry.date, entryPrice: entry.open, markDate: mark.date, markPrice: mark.close };
  }
  return { status: 'closed', entryDate: entry.date, entryPrice: entry.open, exitDate: exit.date, exitPrice: exit.open };
}

// ---------- self-check ----------

if (process.argv.includes('--selfcheck')) {
  const { strict: assert } = await import('node:assert');
  // 14 synthetic sessions, deliberately skipping a "holiday" (2026-01-05).
  const s: Bar[] = ['01-01','01-02','01-06','01-07','01-08','01-09','01-12','01-13','01-14','01-15','01-16','01-19','01-20','01-21']
    .map((d, i) => ({ date: `2026-${d}`, open: 100 + i, close: 100 + i + 0.5 }));

  // Pick made on 2026-01-01 must enter at the NEXT session's open, never the same day.
  const r = resolve(s, '2026-01-01');
  assert.equal(r.status, 'closed');
  assert.equal((r as any).entryDate, '2026-01-02');
  assert.equal((r as any).entryPrice, 101);
  // 10 sessions after index 1 is index 11 = 2026-01-19, correctly skipping the holiday.
  assert.equal((r as any).exitDate, '2026-01-19');
  assert.equal((r as any).exitPrice, 111);

  // Not enough forward sessions yet -> open, never silently closed early.
  assert.equal(resolve(s, '2026-01-14').status, 'open');
  // No session after the pick at all -> pending.
  assert.equal(resolve(s, '2026-12-31').status, 'pending');
  // A pick dated on a session still enters the following session (no same-day fill).
  assert.equal((resolve(s, '2026-01-02') as any).entryDate, '2026-01-06');

  // Excess return arithmetic
  const ret = 111 / 101 - 1, spy = 105 / 100 - 1;
  assert.ok(Math.abs((ret - spy) - 0.049010) < 1e-5, 'excess return math');

  console.log('settle self-checks passed');
  process.exit(0);
}

// ---------- settle ----------

// Study picks and live event-driven picks are settled with identical arithmetic,
// but tagged so the pre-registered test can count ONLY the study picks.
const sources = [
  { dir: `${ROOT}data/picks`, study: true },
  { dir: `${ROOT}data/live`, study: false },
];
const files = sources.flatMap((s) => lsJSON(s.dir).map((f) => ({ path: `${s.dir}/${f}`, study: s.study })));

// With no picks the loop is a no-op, but outcomes.json is still written so the
// dashboard can show the opening balance rather than nothing at all.
const spy = files.length ? await bars('SPY', '2y') : [];
const spyByDate = new Map(spy.map((b) => [b.date, b]));
const seriesCache = new Map<string, Bar[]>();

const positions: any[] = [];
let closed = 0, open = 0, pending = 0;

for (const f of files) {
  const pick = readJSON<any>(f.path, null);
  if (!pick) continue;
  const pickDate = pick.date;
  const horizon = pick.horizonTradingDays ?? HORIZON;

  // Every arm is settled: Council is the primary test, A/B/C are exploratory.
  const entries: { arm: string; ticker: string; rank: number }[] = [
    ...(pick.council ?? []).map((p: any) => ({ arm: 'council', ticker: p.ticker, rank: p.rank })),
    ...(pick.arms ?? []).flatMap((a: any) => (a.picks ?? []).map((p: any) => ({ arm: a.id, ticker: p.ticker, rank: p.rank }))),
  ];

  for (const e of entries) {
    if (!seriesCache.has(e.ticker)) {
      try { seriesCache.set(e.ticker, await bars(e.ticker.replace(/\./g, '-'), '2y')); }
      catch { seriesCache.set(e.ticker, []); }
    }
    const series = seriesCache.get(e.ticker)!;
    if (!series.length) continue;

    const r = resolve(series, pickDate, horizon);
    // Last 30 closes power the inline sparkline; bars are already in memory.
    const spark = series.slice(-30).map((b) => Number(b.close.toFixed(2)));
    const base = { arm: e.arm, study: f.study, horizon, pickDate, ticker: e.ticker, rank: e.rank, weekKey: weekKey(pickDate), spark };

    if (r.status === 'pending') { pending++; positions.push({ ...base, status: 'pending' }); continue; }

    const sEntry = spyByDate.get(r.entryDate);
    if (!sEntry) { pending++; positions.push({ ...base, status: 'pending', note: 'no SPY bar for entry date' }); continue; }

    if (r.status === 'open') {
      const sMark = spyByDate.get(r.markDate);
      open++;
      positions.push({
        ...base, status: 'open',
        entryDate: r.entryDate, entryPrice: r.entryPrice,
        markDate: r.markDate, markPrice: r.markPrice,
        // Mark-to-market is display only and is NOT an input to the primary test.
        markExcess: sMark ? Number(((r.markPrice / r.entryPrice - 1) - (sMark.close / sEntry.open - 1)).toFixed(6)) : null,
      });
      continue;
    }

    const sExit = spyByDate.get(r.exitDate);
    if (!sExit) { open++; positions.push({ ...base, status: 'open', entryDate: r.entryDate, entryPrice: r.entryPrice, note: 'no SPY bar for exit date' }); continue; }

    const ret = r.exitPrice / r.entryPrice - 1;
    const spyRet = sExit.open / sEntry.open - 1;
    closed++;
    positions.push({
      ...base, status: 'closed',
      entryDate: r.entryDate, entryPrice: r.entryPrice,
      exitDate: r.exitDate, exitPrice: r.exitPrice,
      spyEntry: sEntry.open, spyExit: sExit.open,
      ret: Number(ret.toFixed(6)), spyRet: Number(spyRet.toFixed(6)),
      excess: Number((ret - spyRet).toFixed(6)),
    });
  }
}

// ---------- simulated portfolio ----------
// Equal-weight stake per auto-invested position. Buying debits cash, the horizon
// exit credits it back with P/L. No leverage, no partial fills, no fees.
const START_EQUITY = 100_000, STAKE = 10_000;
const live = positions.filter((p) => p.study === false && p.status !== 'pending');
let realized = 0, unrealized = 0, openCount = 0;
for (const p of live) {
  if (p.status === 'closed') realized += STAKE * p.ret;
  else if (p.markPrice && p.entryPrice) { unrealized += STAKE * (p.markPrice / p.entryPrice - 1); openCount++; }
}
const portfolio = {
  startEquity: START_EQUITY, stakePerPosition: STAKE,
  cash: Number((START_EQUITY - openCount * STAKE + realized).toFixed(2)),
  invested: Number((openCount * STAKE + unrealized).toFixed(2)),
  equity: Number((START_EQUITY + realized + unrealized).toFixed(2)),
  realized: Number(realized.toFixed(2)),
  unrealized: Number(unrealized.toFixed(2)),
  totalReturnPct: Number((((realized + unrealized) / START_EQUITY) * 100).toFixed(3)),
  openPositions: openCount,
  closedPositions: live.filter((p) => p.status === 'closed').length,
};

writeJSON(`${ROOT}data/outcomes.json`, {
  portfolio,
  updated: new Date().toISOString(),
  horizonTradingDays: HORIZON,
  rule: 'entry = open of first session after pick; exit = open 10 sessions later; excess vs SPY over identical sessions',
  counts: { closed, open, pending },
  positions,
});

const councilClosed = positions.filter((p) => p.study && p.arm === 'council' && p.status === 'closed').length;
const liveOpen = positions.filter((p) => !p.study && p.status === 'open').length;
console.log(`settled: ${closed} closed, ${open} open, ${pending} pending (${liveOpen} live event-driven open)`);
console.log(`council closed picks: ${councilClosed}/100 toward the pre-registered evaluation`);
