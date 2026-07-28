// The council engine: four specialists analyse independently, then a fixed
// four-step rubric turns their findings into one action. Used by both the weekly
// study (council.ts) and the live event watcher (watch.ts).
//
// Stage 1  four specialists, parallel, identical evidence, different lens
// Stage 2  rubric:
//   1. Verify the evidence      - claims corroborated by another specialist
//   2. Weight each vote         - specialty relevance x verification x confidence
//   3. Measure agreement        - weighted share held by the leading verdict
//   4. Investigate disagreement - one debate round, ONLY when the split is credible
import { streamObject, generateText } from 'ai';

// Reasoning models reject `temperature`; the SDK logs a warning per call and ignores it.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;
import { z } from 'zod';

/**
 * Findings requested per specialist. Each carries evidence, a counter-case and
 * reasoning, so this directly drives generation length. At 8 across 10 tickers the
 * gateway killed two of four arms with gateway_stream_timeout; 5 keeps responses
 * inside the stream budget.
 */
export const MAX_FINDINGS = 5;

/** Agreement at or above this needs no debate. Pre-declared, not tuned. */
export const AGREEMENT_OK = 0.75;
/** Minimum weighted agreement for the council to act at all. */
export const ACT_MIN_AGREEMENT = 0.60;
/** Minimum specialists voting the winning verdict for the council to act. */
export const ACT_MIN_VOTES = 2;
/** Minimum specialists that must have responded before the council may open a position. */
export const ACT_MIN_PANEL = 3;
/**
 * Per-specialist wall-clock cap. Measured latencies vary widely (Claude ~30s,
 * Kimi 77-242s), so one slow model must not hold the whole council open. A
 * specialist that times out is recorded as unavailable and the rubric proceeds
 * with the rest, exactly as it would for an API failure. Set above the slowest
 * observed real run (Kimi at 242s) so this fires only on a genuine hang.
 */
export const SPECIALIST_TIMEOUT_MS = Number(process.env.SPECIALIST_TIMEOUT_MS ?? 330_000);

export type EventKind = 'policy' | 'filing' | 'headline' | 'shock' | 'mixed';

export const FALLBACK = process.env.COUNCIL_FALLBACK === '1';

type Arm = {
  id: string; model: string; name: string; role_title: string; specialty: string; role: string;
  /** Relevance multiplier by event kind. A policy expert counts for more on policy. */
  relevance: Record<EventKind, number>;
};

const SPECIALISTS: Arm[] = [
  {
    id: 'A', model: process.env.ARM_A ?? 'anthropic/claude-opus-5', name: 'Claude Opus 5', role_title: 'The Analyst',
    specialty: 'Fundamentals, accounting, valuation and earnings impact',
    role: 'You are the FUNDAMENTALS analyst. Judge only on business economics: revenue and margin '
      + 'impact, balance sheet, cash flow, accounting quality, valuation versus history, and how the '
      + 'event changes reported earnings. Ignore narrative and momentum.',
    relevance: { filing: 1.5, policy: 1.0, headline: 1.0, shock: 0.9, mixed: 1.2 },
  },
  {
    id: 'B', model: process.env.ARM_B ?? 'openai/gpt-5.6-sol', name: 'ChatGPT 5.6 Sol', role_title: 'The Auditor',
    specialty: 'Evidence verification and causal reasoning',
    role: 'You are the VERIFIER. Test whether the evidence actually supports the conclusion, in '
      + 'either direction: check that the claimed cause drives the price rather than coinciding with '
      + 'it, and that the move is not already priced in. State the strongest counter-case to whatever '
      + 'you conclude. Verifying that a bullish case DOES hold is as much your job as refuting one.',
    relevance: { headline: 1.5, shock: 1.3, filing: 1.0, policy: 1.0, mixed: 1.2 },
  },
  {
    id: 'C', model: process.env.ARM_C ?? 'alibaba/qwen3.7-max', name: 'Qwen 3.7 Max', role_title: 'The Strategist',
    specialty: 'Policy, market sentiment and China/Hong Kong exposure',
    role: 'You are the POLICY and SENTIMENT analyst, with particular depth on China and Hong Kong '
      + 'exposure. Judge regulatory direction, supply chain and trade policy, and how positioning and '
      + 'sentiment are likely to shift. Flag policy risk the others would miss.',
    relevance: { policy: 1.5, headline: 1.1, filing: 0.9, shock: 1.0, mixed: 1.2 },
  },
  {
    id: 'D', model: process.env.ARM_D ?? 'moonshotai/kimi-k3', name: 'Kimi K3', role_title: 'The Forecaster',
    specialty: 'Second-order consequences and long-document synthesis',
    role: 'You are the SECOND-ORDER analyst. Synthesise across everything provided and reason about '
      + 'knock-on effects: suppliers, customers, competitors, substitutes, and what the market has not '
      + 'yet priced. Say explicitly what happens next, not just what happened.',
    relevance: { policy: 1.2, filing: 1.2, headline: 1.0, shock: 1.0, mixed: 1.3 },
  },
];

const FREE = 'openai/gpt-oss-120b';
export const ARMS: Arm[] = (FALLBACK
  ? SPECIALISTS.map((a) => ({ ...a, model: FREE }))
  : SPECIALISTS).filter((a) => a.model !== 'off');

export const Analysis = z.object({
  findings: z.array(z.object({
    ticker: z.string().describe('exactly one of the allowed tickers'),
    verdict: z.enum(['BUY', 'SELL', 'HOLD']),
    confidence: z.number().int().min(1).max(10),
    evidence: z.array(z.string()).max(3).describe('short factual claims taken from the material provided'),
    risk: z.string().describe('the single strongest argument against your own verdict'),
    reasoning: z.string().describe('under 350 characters'),
  })).max(MAX_FINDINGS),
});

export type Finding = z.infer<typeof Analysis>['findings'][number];
export type ArmResult = {
  id: string; model: string; name: string; role_title?: string; specialty: string;
  ok: boolean; error?: string | null; latencyMs?: number; usage?: unknown;
  findings: Finding[]; revised?: boolean;
};

const JSON_TAIL = `

Reply with ONLY a JSON object, no prose and no markdown fence:
{"findings":[{"ticker":"XXX","verdict":"BUY","confidence":7,"evidence":["..."],"risk":"...","reasoning":"..."}]}
An empty findings array is valid.`;

/** Rejects if the specialist has not finished within the cap. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s (${label})`)), ms);
    }),
  ]);
}

async function callModel(model: string, prompt: string) {
  if (FALLBACK) {
    const { text, usage } = await generateText({ model, prompt: prompt + JSON_TAIL, temperature: 0 });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no JSON in response: ${text.slice(0, 100)}`);
    return { object: Analysis.parse(JSON.parse(m[0])), usage };
  }
  // Streaming is the one call path every gateway model accepts.
  try {
    const res = streamObject({ model, schema: Analysis, temperature: 0, prompt });
    for await (const _ of res.partialObjectStream) { /* drain */ }
    return { object: await res.object, usage: await res.usage };
  } catch (err) {
    // Some models emit valid JSON that fails strict tool-calling validation.
    // Asking for raw JSON and validating it ourselves recovers those instead of
    // losing the specialist and degrading the panel.
    if (!/schema|No object generated/i.test(String((err as Error).message))) throw err;
    console.error(`    ${model}: schema path failed, retrying as raw JSON`);
    return viaText(model, prompt);
  }
}

/** Stage 1: every specialist sees identical evidence through its own lens. */
export async function runSpecialists(evidence: string, valid: Set<string>): Promise<ArmResult[]> {
  const run = async (arm: Arm): Promise<ArmResult> => {
    const t0 = Date.now();
    const base = { id: arm.id, model: arm.model, name: arm.name, role_title: arm.role_title, specialty: arm.specialty };
    try {
      const { object, usage } = await withTimeout(
        callModel(arm.model, `${arm.role}\n\n${evidence}`), SPECIALIST_TIMEOUT_MS, arm.name);
      const findings = object.findings
        .map((f) => ({ ...f, ticker: f.ticker.toUpperCase() }))
        .filter((f) => valid.has(f.ticker));
      console.error(`  ${arm.id} ${arm.name}: ${findings.length} finding(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { ...base, findings, usage, ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      console.error(`  ! ${arm.id} ${arm.name} FAILED: ${(err as Error).message}`);
      return { ...base, findings: [], ok: false, error: (err as Error).message, latencyMs: Date.now() - t0 };
    }
  };
  if (!FALLBACK) return Promise.all(ARMS.map(run));
  const out: ArmResult[] = [];
  for (const a of ARMS) { out.push(await run(a)); await new Promise((r) => setTimeout(r, 8000)); }
  return out;
}

// ---------- the rubric ----------

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was',
  'were', 'has', 'have', 'its', 'this', 'that', 'with', 'by', 'at', 'from', 'as', 'it', 'be', 'will']);
const keywords = (s: string) => new Set(
  String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)),
);

/** Step 1. A claim is verified when another specialist independently asserts something similar. */
function verifyEvidence(mine: string[], others: string[][]): number {
  if (!mine.length) return 0;
  const pool = others.flat().map(keywords);
  let hits = 0;
  for (const claim of mine) {
    const k = keywords(claim);
    if (!k.size) continue;
    const corroborated = pool.some((o) => {
      let shared = 0;
      for (const w of k) if (o.has(w)) shared++;
      return shared >= 2;
    });
    if (corroborated) hits++;
  }
  return hits / mine.length;
}

export type Opinion = {
  arm: string; name: string; roleTitle?: string; specialty: string; verdict: string; confidence: number;
  verified: number; relevance: number; weight: number;
  evidence: string[]; risk: string; reasoning: string; revised?: boolean;
};

export type TickerVerdict = {
  ticker: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  agreement: number;
  weightedShare: Record<string, number>;
  votes: number;
  meanConfidence: number;
  invest: boolean;
  panel: number;
  debated: boolean;
  opinions: Opinion[];
};

/** Steps 1-3: verify, weight, measure. Pure arithmetic, no model involved. */
export function score(results: ArmResult[], kind: EventKind): TickerVerdict[] {
  const live = results.filter((r) => r.ok);
  const panelHealthy = live.length >= ACT_MIN_PANEL;
  const tickers = [...new Set(live.flatMap((r) => r.findings.map((f) => f.ticker)))];

  return tickers.map((ticker) => {
    const rows = live
      .map((r) => ({ arm: r, finding: r.findings.find((f) => f.ticker === ticker) }))
      .filter((x) => x.finding) as { arm: ArmResult; finding: Finding }[];

    const opinions: Opinion[] = rows.map(({ arm, finding }) => {
      const others = rows.filter((x) => x.arm.id !== arm.id).map((x) => x.finding.evidence ?? []);
      // With no second opinion available, verification is unknown rather than failed.
      const verified = others.length ? verifyEvidence(finding.evidence ?? [], others) : 0.5;
      const relevance = ARMS.find((a) => a.id === arm.id)?.relevance[kind] ?? 1;
      const weight = relevance * (0.5 + 0.5 * verified) * (finding.confidence / 10);
      return {
        arm: arm.id, name: arm.name, roleTitle: arm.role_title, specialty: arm.specialty,
        verdict: finding.verdict, confidence: finding.confidence,
        verified: Number(verified.toFixed(2)), relevance,
        weight: Number(weight.toFixed(3)),
        evidence: finding.evidence ?? [], risk: finding.risk, reasoning: finding.reasoning,
        revised: arm.revised,
      };
    });

    const total = opinions.reduce((a, o) => a + o.weight, 0) || 1;
    const byVerdict: Record<string, number> = { BUY: 0, SELL: 0, HOLD: 0 };
    for (const o of opinions) byVerdict[o.verdict] += o.weight;
    const action = Object.entries(byVerdict).sort((a, b) => b[1] - a[1])[0][0] as TickerVerdict['action'];
    const agreement = byVerdict[action] / total;
    const votes = opinions.filter((o) => o.verdict === action).length;

    return {
      ticker, action,
      agreement: Number(agreement.toFixed(3)),
      weightedShare: Object.fromEntries(
        Object.entries(byVerdict).map(([k, v]) => [k, Number((v / total).toFixed(3))]),
      ),
      votes,
      meanConfidence: Number((opinions.reduce((a, o) => a + o.confidence, 0) / opinions.length).toFixed(2)),
      invest: panelHealthy && action === 'BUY' && agreement >= ACT_MIN_AGREEMENT && votes >= ACT_MIN_VOTES,
      panel: live.length,
      debated: false,
      opinions,
    };
  }).sort((a, b) => b.agreement - a.agreement || a.ticker.localeCompare(b.ticker));
}

/**
 * Step 4 trigger. A split is worth debating only when a dissenter's evidence was
 * actually corroborated; an unsupported outlier is noise, not a credible objection.
 */
export const credibleSplit = (v: TickerVerdict) =>
  v.agreement < AGREEMENT_OK
  && v.opinions.some((o) => o.verdict !== v.action && o.verified >= 0.5);

/** Step 4 execution: every specialist sees all cases, then may revise. */
export async function debate(
  results: ArmResult[], contested: TickerVerdict[], evidence: string, valid: Set<string>,
): Promise<ArmResult[]> {
  const table = contested.map((v) => `${v.ticker} - council leaning ${v.action} `
    + `(agreement ${(v.agreement * 100).toFixed(0)}%)\n`
    + v.opinions.map((o) => `  ${o.name} [${o.specialty}] says ${o.verdict} (confidence ${o.confidence}): `
      + `${o.reasoning} | strongest counter: ${o.risk}`).join('\n')).join('\n\n');

  const prompt = `${evidence}

THE COUNCIL DISAGREES. Here is every specialist's position on the contested stocks:

${table}

Reconsider only these tickers: ${contested.map((v) => v.ticker).join(', ')}.
You have now seen arguments from outside your own specialty. Where another specialist has identified
something your lens genuinely missed, change your verdict. Where you still disagree, hold your
position and say why the counter-argument fails. Changing your mind on good evidence is correct
behaviour, and so is refusing to.`;

  const contestedSet = new Set(contested.map((v) => v.ticker));
  const run = async (r: ArmResult): Promise<ArmResult> => {
    if (!r.ok) return r;
    const arm = ARMS.find((a) => a.id === r.id)!;
    try {
      const { object } = await withTimeout(
        callModel(arm.model, `${arm.role}\n\n${prompt}`), SPECIALIST_TIMEOUT_MS, arm.name);
      const revisedFindings = object.findings
        .map((f) => ({ ...f, ticker: f.ticker.toUpperCase() }))
        .filter((f) => valid.has(f.ticker) && contestedSet.has(f.ticker));
      // Keep uncontested findings untouched; replace only the debated ones.
      const kept = r.findings.filter((f) => !contestedSet.has(f.ticker));
      const changed = revisedFindings.some((f) => {
        const before = r.findings.find((x) => x.ticker === f.ticker);
        return before && before.verdict !== f.verdict;
      });
      console.error(`  ${r.id} ${r.name}: debate ${changed ? 'CHANGED position' : 'held position'}`);
      return { ...r, findings: [...kept, ...revisedFindings], revised: changed };
    } catch (err) {
      console.error(`  ! ${r.id} debate failed, keeping original: ${(err as Error).message}`);
      return r;
    }
  };
  if (!FALLBACK) return Promise.all(results.map(run));
  const out: ArmResult[] = [];
  for (const r of results) { out.push(await run(r)); await new Promise((rr) => setTimeout(rr, 8000)); }
  return out;
}

/** Full pipeline: analyse, score, debate only where the split is credible, rescore. */
export async function convene(evidence: string, valid: Set<string>, kind: EventKind) {
  const first = await runSpecialists(evidence, valid);
  const live = first.filter((r) => r.ok);
  if (live.length < 2) {
    return { results: first, verdicts: [] as TickerVerdict[], debated: [] as string[], armsLive: live.length };
  }

  let verdicts = score(first, kind);
  const contested = verdicts.filter(credibleSplit);
  let results = first;

  if (contested.length) {
    console.error(`  step 4: ${contested.length} credible disagreement(s) -> debate round`);
    results = await debate(first, contested, evidence, valid);
    const names = new Set(contested.map((v) => v.ticker));
    verdicts = score(results, kind).map((v) => (names.has(v.ticker) ? { ...v, debated: true } : v));
  } else {
    console.error('  step 4: no credible disagreement, debate skipped');
  }

  return {
    results, verdicts,
    debated: contested.map((v) => v.ticker),
    armsLive: results.filter((r) => r.ok).length,
  };
}

/** Mean pairwise Jaccard distance across specialists' BUY sets. Exploratory only. */
export function disagreementRate(results: ArmResult[]): number | null {
  const sets = results.filter((r) => r.ok)
    .map((r) => new Set(r.findings.filter((f) => f.verdict === 'BUY').map((f) => f.ticker)));
  const js: number[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const union = new Set([...sets[i], ...sets[j]]).size;
      if (!union) continue;
      js.push([...sets[i]].filter((t) => sets[j].has(t)).length / union);
    }
  }
  return js.length ? Number((1 - js.reduce((a, b) => a + b, 0) / js.length).toFixed(3)) : null;
}

// ---------- self-check ----------

if (import.meta.filename === process.argv[1]) {
  const { strict: assert } = await import('node:assert');
  const mk = (id: string, verdict: any, confidence: number, evidence: string[]): ArmResult => ({
    id, model: 'test', name: `M${id}`, specialty: 's', ok: true,
    findings: [{ ticker: 'AAA', verdict, confidence, evidence, risk: 'r', reasoning: 'x' }],
  });

  // Unanimous BUY with corroborated evidence must act and must NOT trigger a debate.
  const agree = score([
    mk('A', 'BUY', 8, ['insider purchase reported filing']),
    mk('B', 'BUY', 7, ['insider purchase disclosed filing']),
    mk('C', 'BUY', 7, ['insider purchase filing']),
  ], 'filing');
  assert.equal(agree[0].action, 'BUY');
  assert.ok(agree[0].agreement > 0.99, `expected consensus, got ${agree[0].agreement}`);
  assert.equal(agree[0].invest, true);
  assert.equal(credibleSplit(agree[0]), false);

  // An even split must not act, and must be flagged for debate.
  const split = score([
    mk('A', 'BUY', 8, ['revenue growth accelerating strongly']),
    mk('B', 'HOLD', 8, ['revenue growth accelerating strongly']),
  ], 'filing');
  assert.equal(split[0].invest, false, 'a 50/50 split must not auto-invest');
  assert.equal(credibleSplit(split[0]), true, 'corroborated dissent is credible');

  // A lone dissenter with uncorroborated evidence is noise, not a credible objection.
  const noise = score([
    mk('A', 'BUY', 9, ['earnings beat consensus materially']),
    mk('B', 'BUY', 9, ['earnings beat consensus materially']),
    mk('C', 'SELL', 2, ['zzzz qqqq wwww']),
  ], 'filing');
  assert.equal(noise[0].action, 'BUY');
  assert.equal(credibleSplit(noise[0]), false, 'unsupported outlier must not force a debate');

  // Specialty relevance must actually move the weighting.
  const pol = score([mk('C', 'BUY', 8, ['tariff policy change'])], 'policy')[0].opinions[0];
  const fil = score([mk('C', 'BUY', 8, ['tariff policy change'])], 'filing')[0].opinions[0];
  assert.ok(pol.weight > fil.weight, 'policy specialist must weigh more on a policy event');

  // SELL never auto-invests, however strong the agreement.
  const sell = score([mk('A', 'SELL', 9, ['guidance cut']), mk('B', 'SELL', 9, ['guidance cut'])], 'filing');
  assert.equal(sell[0].action, 'SELL');
  assert.equal(sell[0].invest, false);

  // A two-model panel must not commit capital, however strongly it agrees.
  const degraded = score([
    mk('A', 'BUY', 9, ['earnings beat consensus materially']),
    mk('B', 'BUY', 9, ['earnings beat consensus materially']),
  ], 'filing');
  assert.equal(degraded[0].action, 'BUY');
  assert.equal(degraded[0].agreement, 1);
  assert.equal(degraded[0].panel, 2);
  assert.equal(degraded[0].invest, false, 'a 2-of-4 panel must not open a position');

  // Three responding specialists in agreement may act.
  const healthy = score([
    mk('A', 'BUY', 9, ['earnings beat consensus materially']),
    mk('B', 'BUY', 9, ['earnings beat consensus materially']),
    mk('C', 'BUY', 8, ['earnings beat consensus materially']),
  ], 'filing');
  assert.equal(healthy[0].panel, 3);
  assert.equal(healthy[0].invest, true, 'a healthy panel in agreement must act');

  console.log('council rubric self-checks passed');
}
