// Weekly council run for the PRE-REGISTERED study. Picks land in data/picks/ and
// are the only picks the primary test counts. Event-driven live picks are separate
// (see watch.ts) and never enter the study.
//
// Usage: node scripts/council.ts [--dry] [--models]
// Requires AI_GATEWAY_API_KEY.
import { bars, readJSON, writeJSON, ROOT, get, lsJSON } from './lib.ts';
import { convene, disagreementRate, ARMS, MAX_FINDINGS, ACT_MIN_AGREEMENT, ACT_MIN_VOTES } from './arms.ts';

const DRY = process.argv.includes('--dry');
const TODAY = new Date().toISOString().slice(0, 10);
const HORIZON_DAYS = 10;

// `--models` lists what the gateway actually offers, so arm IDs can be set correctly.
if (process.argv.includes('--models')) {
  const res = await get('https://ai-gateway.vercel.sh/v1/models', {
    headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
  });
  console.log(((await res.json()).data ?? []).map((m: any) => m.id).sort().join('\n'));
  process.exit(0);
}

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('AI_GATEWAY_API_KEY is not set.');
  console.error('Get one at https://vercel.com/ai-gateway, then: export AI_GATEWAY_API_KEY=...');
  console.error('List valid arm model IDs with: node scripts/council.ts --models');
  process.exit(1);
}

const dir = `${ROOT}data/candidates`;
const latest = lsJSON(dir).pop();
if (!latest) throw new Error('no candidates found — run `npm run screen` first');
const { candidates, date: candidateDate } = readJSON<any>(`${dir}/${latest}`, {});
console.error(`candidates: ${latest} (${candidates.length} tickers)`);

const pct = (a: number, b: number) => (((a - b) / b) * 100).toFixed(1);
const briefs: string[] = [];

for (const c of candidates) {
  let priceLine = 'price data unavailable';
  try {
    const b = await bars(c.yahoo, '1y');
    const last = b.at(-1)!;
    const back = (n: number) => b[Math.max(0, b.length - 1 - n)].close;
    priceLine = `last close ${last.close.toFixed(2)} (${last.date}) | 1m ${pct(last.close, back(21))}% | ` +
      `3m ${pct(last.close, back(63))}% | ${pct(last.close, Math.max(...b.map((x) => x.close)))}% from 52w high`;
  } catch { /* a missing series must not block the run */ }

  const buys = c.purchases.length
    ? c.purchases.map((p: any) => `${p.owners[0]} bought ${p.shares.toLocaleString()} @ $${p.price || 'n/a'} on ${p.date}`).join('; ')
    : 'none';

  briefs.push(
    `${c.ticker} — ${c.name} (${c.sector})\n` +
    `  screen score ${c.score} | insider buyers (35d): ${c.buyCount} | 8-K filings 35d: ${c.count8k35} (ratio ${c.ratio})\n` +
    `  insider open-market purchases: ${buys}\n  ${priceLine}`,
  );
}

const BRIEF = `You are selecting US equities for a research study with strictly mechanical rules.

RULES YOU MUST ASSUME:
- Horizon is exactly ${HORIZON_DAYS} trading days. Entry is the NEXT session's open; exit is the open ${HORIZON_DAYS} sessions later.
- Every position is EQUAL WEIGHT. No stop-losses, no early exits. Nothing is adjusted after entry.
- You are measured on return in excess of SPY over that same window. A stock that rises less than SPY is a loss.
- You may ONLY choose from the candidate list below. Do not name any other ticker.

These candidates came from a mechanical screen (insider open-market buying and abnormal 8-K
disclosure volume). The screen implies nothing about direction — it only surfaces names to examine.

CANDIDATES (as of ${candidateDate}):
${briefs.join('\n\n')}

Give a verdict for EVERY candidate listed above, one finding per ticker, no more and no fewer.
Skipping a candidate is not permitted: if the evidence says little about it, return HOLD and say so.
Verdict is BUY, SELL or HOLD. All three are real answers. Do not invent a trade to look useful,
and do not default to HOLD to look cautious.
Every claim in "evidence" must come from the material above, not from memory.
"risk" must be the strongest argument AGAINST your own verdict.
Confidence is 1-10 and is recorded but does NOT affect position size.`;

const valid = new Set<string>(candidates.map((c: any) => c.ticker.toUpperCase()));
// The weekly screen mixes insider filings and disclosure volume, so no single lens dominates.
const { results, verdicts, debated, armsLive } = await convene(BRIEF, valid, 'mixed');
if (armsLive < 2) throw new Error(`only ${armsLive} specialist(s) responded - refusing to publish a council vote`);
if (armsLive < ARMS.length) console.error(`  ! running with ${armsLive}/${ARMS.length} specialists; recorded in the pick file`);

const buys = verdicts.filter((v) => v.invest);

console.log(`\ncouncil verdicts (${TODAY}):`);
console.table(verdicts.map((v) => ({
  ticker: v.ticker, action: v.action, agreement: `${(v.agreement * 100).toFixed(0)}%`,
  votes: v.votes, conf: v.meanConfidence, debated: v.debated ? 'yes' : '', buy: v.invest ? 'YES' : '',
})));
console.log(`${buys.length} cleared the gate (${Math.round(ACT_MIN_AGREEMENT * 100)}% agreement, ${ACT_MIN_VOTES}+ votes)`);

if (DRY) console.log('\n--dry: nothing written');
else {
  writeJSON(`${ROOT}data/picks/${TODAY}.json`, {
    date: TODAY,
    candidateFile: latest,
    horizonTradingDays: HORIZON_DAYS,
    eventKind: 'mixed',
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
  });
  console.log(`wrote data/picks/${TODAY}.json`);
}
