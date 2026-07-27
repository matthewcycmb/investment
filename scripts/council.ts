// Weekly council run. Three frontier models each pick independently from an
// identical brief; the Council arm is a deterministic vote aggregation over them
// (PREREGISTRATION.md §4). Arm A is the pre-declared single-model control.
//
// Usage: node scripts/council.ts [--dry] [--models]
// Requires AI_GATEWAY_API_KEY.
import { generateObject } from 'ai';
import { z } from 'zod';
import { bars, readJSON, writeJSON, ROOT, get, lsJSON } from './lib.ts';

const DRY = process.argv.includes('--dry');
const TODAY = new Date().toISOString().slice(0, 10);
const HORIZON_DAYS = 10;
const PICKS_PER_ARM = 8;

const ARMS = [
  { id: 'A', model: process.env.ARM_A ?? 'anthropic/claude-sonnet-5', control: true },
  { id: 'B', model: process.env.ARM_B ?? 'openai/gpt-5', control: false },
  { id: 'C', model: process.env.ARM_C ?? 'google/gemini-3-pro', control: false },
];

// `--models` lists what the gateway actually offers, so arm IDs can be set correctly.
if (process.argv.includes('--models')) {
  const res = await get('https://ai-gateway.vercel.sh/v1/models', {
    headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
  });
  const models = (await res.json()).data ?? [];
  console.log(models.map((m: any) => m.id).sort().join('\n'));
  process.exit(0);
}

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('AI_GATEWAY_API_KEY is not set.');
  console.error('Get one at https://vercel.com/ai-gateway, then: export AI_GATEWAY_API_KEY=...');
  console.error('List valid arm model IDs with: node scripts/council.ts --models');
  process.exit(1);
}

// ---------- load the week's candidates ----------

const dir = `${ROOT}data/candidates`;
const latest = lsJSON(dir).pop();
if (!latest) throw new Error('no candidates found — run `npm run screen` first');
const { candidates, date: candidateDate } = readJSON<any>(`${dir}/${latest}`, {});
console.error(`candidates: ${latest} (${candidates.length} tickers)`);

// ---------- price context (identical for every arm) ----------

const pct = (a: number, b: number) => (((a - b) / b) * 100).toFixed(1);

const briefs = [];
for (const c of candidates) {
  let priceLine = 'price data unavailable';
  try {
    const b = await bars(c.yahoo, '1y');
    const last = b.at(-1)!;
    const back = (n: number) => b[Math.max(0, b.length - 1 - n)].close;
    const high52 = Math.max(...b.map((x) => x.close));
    priceLine =
      `last close ${last.close.toFixed(2)} (${last.date}) | ` +
      `1m ${pct(last.close, back(21))}% | 3m ${pct(last.close, back(63))}% | ` +
      `${pct(last.close, high52)}% from 52w high`;
  } catch { /* a missing series must not block the run */ }

  const buys = c.purchases.length
    ? c.purchases.map((p: any) =>
        `${p.owners.join('/')} bought ${p.shares.toLocaleString()} @ $${p.price || 'n/a'} on ${p.date}`).join('; ')
    : 'none';

  briefs.push(
    `${c.ticker} — ${c.name} (${c.sector})\n` +
    `  screen score ${c.score} | distinct insider buyers (35d): ${c.buyCount} | 8-K filings 35d: ${c.count8k35} (ratio ${c.ratio})\n` +
    `  insider open-market purchases: ${buys}\n` +
    `  ${priceLine}`,
  );
}

const BRIEF = `You are selecting US equities for a research study with strictly mechanical rules.

RULES YOU MUST ASSUME:
- Horizon is exactly ${HORIZON_DAYS} trading days. Entry is the NEXT session's open; exit is the open ${HORIZON_DAYS} sessions later.
- Every position is EQUAL WEIGHT. There are no stop-losses and no early exits. Nothing is adjusted after entry.
- You are measured on return in excess of SPY over that same window. Beating the index is the only thing that counts; a stock that rises less than SPY is a loss.
- You may ONLY choose from the candidate list below. Do not name any other ticker.

These candidates were selected by a mechanical screen (insider open-market buying and abnormal 8-K
disclosure volume). The screen implies nothing about direction — it only surfaces names worth examining.

CANDIDATES (as of ${candidateDate}):
${briefs.join('\n\n')}

Select the ${PICKS_PER_ARM} candidates most likely to beat SPY over the next ${HORIZON_DAYS} trading days,
ranked best first. For each, give a specific thesis grounded in the evidence above — name the
catalyst and why it should move the price within the window, not generic company description.
Give an honest 1-10 confidence; it is recorded but does NOT affect position size.`;

const ArmOutput = z.object({
  picks: z.array(z.object({
    ticker: z.string().describe('exactly one of the candidate tickers'),
    thesis: z.string().describe('specific, evidence-grounded rationale, under 500 characters'),
    confidence: z.number().int().min(1).max(10),
  })).min(1).max(PICKS_PER_ARM),
});

// ---------- run the three independent arms ----------

const valid = new Set(candidates.map((c: any) => c.ticker));

const armResults = await Promise.all(ARMS.map(async (arm) => {
  const t0 = Date.now();
  try {
    const { object, usage } = await generateObject({
      model: arm.model,
      schema: ArmOutput,
      prompt: BRIEF,
      temperature: 0,
    });
    const picks = object.picks
      .filter((p) => {
        if (valid.has(p.ticker)) return true;
        console.error(`  ! arm ${arm.id} hallucinated ticker ${p.ticker} — dropped`);
        return false;
      })
      .map((p, i) => ({ ...p, rank: i + 1 }));
    console.error(`  arm ${arm.id} (${arm.model}): ${picks.length} picks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { ...arm, picks, usage, ok: true };
  } catch (err) {
    console.error(`  ! arm ${arm.id} (${arm.model}) FAILED: ${(err as Error).message}`);
    return { ...arm, picks: [], usage: null, ok: false, error: (err as Error).message };
  }
}));

const live = armResults.filter((a) => a.ok && a.picks.length);
if (live.length < 2) throw new Error(`only ${live.length} arm(s) succeeded — refusing to publish a council vote`);
if (live.length < ARMS.length) console.error(`  ! running with ${live.length}/${ARMS.length} arms; recorded in the pick file`);

// ---------- deterministic council aggregation (PREREGISTRATION.md §4) ----------

const tally = new Map<string, { votes: number; rankPointsSum: number; confSum: number; theses: any[] }>();
for (const arm of live) {
  for (const p of arm.picks) {
    const e = tally.get(p.ticker) ?? { votes: 0, rankPointsSum: 0, confSum: 0, theses: [] };
    e.votes++;
    e.rankPointsSum += 9 - p.rank;
    e.confSum += p.confidence;
    e.theses.push({ arm: arm.id, rank: p.rank, confidence: p.confidence, thesis: p.thesis });
    tally.set(p.ticker, e);
  }
}

const council = [...tally.entries()]
  .map(([ticker, e]) => ({
    ticker,
    votes: e.votes,
    rankPoints: Number((e.rankPointsSum / e.votes).toFixed(3)),
    meanConfidence: Number((e.confSum / e.votes).toFixed(2)),
    theses: e.theses,
  }))
  .sort((a, b) => b.votes - a.votes || b.rankPoints - a.rankPoints || a.ticker.localeCompare(b.ticker))
  .slice(0, PICKS_PER_ARM)
  .map((p, i) => ({ ...p, rank: i + 1 }));

// Exploratory: how much do the models actually disagree? (mean pairwise Jaccard distance)
const sets = live.map((a) => new Set(a.picks.map((p) => p.ticker)));
const jaccards: number[] = [];
for (let i = 0; i < sets.length; i++) {
  for (let j = i + 1; j < sets.length; j++) {
    const inter = [...sets[i]].filter((t) => sets[j].has(t)).length;
    jaccards.push(inter / new Set([...sets[i], ...sets[j]]).size);
  }
}
const disagreement = jaccards.length ? Number((1 - jaccards.reduce((a, b) => a + b, 0) / jaccards.length).toFixed(3)) : null;

const out = {
  date: TODAY,
  candidateFile: latest,
  horizonTradingDays: HORIZON_DAYS,
  aggregation: 'PREREGISTRATION.md §4: votes desc, then mean rankPoints desc, then ticker asc',
  arms: armResults.map((a) => ({
    id: a.id, model: a.model, control: a.control, ok: a.ok,
    error: (a as any).error ?? null,
    usage: a.usage ?? null,
    picks: a.picks,
  })),
  council,
  exploratory: { disagreementRate: disagreement, armsLive: live.length },
};

console.log(`\ncouncil picks (${TODAY}):`);
console.table(council.map((c) => ({ rank: c.rank, ticker: c.ticker, votes: c.votes, rankPoints: c.rankPoints, conf: c.meanConfidence })));
console.log(`inter-model disagreement: ${disagreement}`);

if (DRY) console.log('\n--dry: nothing written');
else {
  writeJSON(`${ROOT}data/picks/${TODAY}.json`, out);
  console.log(`wrote data/picks/${TODAY}.json`);
}
