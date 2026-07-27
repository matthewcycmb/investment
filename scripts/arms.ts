// Shared council runner. Both the weekly study (council.ts) and the live event
// watcher (watch.ts) call this, so the voting logic exists in exactly one place.
import { generateObject, generateText } from 'ai';
import { z } from 'zod';

export const PICKS_PER_ARM = 8;

/**
 * Arm models. Override per-arm with ARM_A..ARM_D env vars.
 * Verified present on the gateway 2026-07-27 via `npm run models`.
 */
// Vercel's FREE credit cannot reach premium models; only openai/gpt-oss-120b works.
// COUNCIL_FALLBACK=1 keeps the pipeline demonstrable on one model by giving each arm a
// distinct analyst persona. Personas are NEVER used with the real four models, because
// the pre-registered study requires every arm to receive an identical brief.
export const FALLBACK = process.env.COUNCIL_FALLBACK === '1';
export const MODE = FALLBACK ? 'fallback-personas-single-model' : 'four-models-identical-brief';

const REAL = [
  { id: 'A', model: process.env.ARM_A ?? 'anthropic/claude-opus-5', control: true },
  { id: 'B', model: process.env.ARM_B ?? 'openai/gpt-5.6-sol', control: false },
  { id: 'C', model: process.env.ARM_C ?? 'alibaba/qwen3.6-plus', control: false },
  { id: 'D', model: process.env.ARM_D ?? 'moonshotai/kimi-k3', control: false },
];

const FREE_MODEL = 'openai/gpt-oss-120b';
const PERSONAS = [
  { id: 'A', control: true,  persona: 'You are a fundamentals-driven value investor. You care about balance sheets, cash flow and whether the market has mispriced the business.' },
  { id: 'B', control: false, persona: 'You are a momentum trader. You care about trend, relative strength and whether flow is already moving into the name.' },
  { id: 'C', control: false, persona: 'You are a sceptical risk manager. You look for reasons a trade fails, and you are comfortable recommending nothing.' },
  { id: 'D', control: false, persona: 'You are an event-driven catalyst trader. You care only about whether a specific, dated catalyst moves the price inside the window.' },
].map((p) => ({ ...p, model: FREE_MODEL }));

export const ARMS: { id: string; model: string; control: boolean; persona?: string }[] =
  (FALLBACK ? PERSONAS : REAL).filter((a) => a.model !== 'off');

export const ArmOutput = z.object({
  picks: z.array(z.object({
    ticker: z.string().describe('exactly one of the allowed tickers'),
    thesis: z.string().describe('specific, evidence-grounded rationale, under 400 characters'),
    confidence: z.number().int().min(1).max(10),
  })).max(PICKS_PER_ARM),
});

export type ArmResult = {
  id: string; model: string; control: boolean; persona?: string; ok: boolean;
  error?: string | null; usage?: unknown; latencyMs?: number;
  picks: { ticker: string; thesis: string; confidence: number; rank: number }[];
};

const JSON_INSTRUCTION = `

Reply with ONLY a JSON object and nothing else - no prose, no markdown fence:
{"picks":[{"ticker":"XXX","thesis":"why","confidence":7}]}
An empty picks array is valid if nothing qualifies.`;

/** Small open models fail strict tool-calling; ask for raw JSON and validate it ourselves. */
async function viaText(model: string, prompt: string) {
  const { text, usage } = await generateText({ model, prompt: prompt + JSON_INSTRUCTION, temperature: 0 });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in response: ${text.slice(0, 120)}`);
  return { object: ArmOutput.parse(JSON.parse(m[0])), usage };
}

/**
 * Run every arm independently on an identical brief. Never throws; failures are recorded.
 * Fallback mode runs arms sequentially with a gap, because free-tier credit is rate-limited.
 */
export async function runArms(brief: string, validTickers: Set<string>): Promise<ArmResult[]> {
  const run = async (arm: typeof ARMS[number]): Promise<ArmResult> => {
    const t0 = Date.now();
    try {
      const prompt = arm.persona ? `${arm.persona}\n\n${brief}` : brief;
      const { object, usage } = FALLBACK
        ? await viaText(arm.model, prompt)
        : await generateObject({ model: arm.model, schema: ArmOutput, temperature: 0, prompt });
      const picks = object.picks
        .filter((p) => {
          const ok = validTickers.has(p.ticker.toUpperCase());
          if (!ok) console.error(`  ! arm ${arm.id} named ${p.ticker}, not in the allowed list — dropped`);
          return ok;
        })
        .map((p, i) => ({ ...p, ticker: p.ticker.toUpperCase(), rank: i + 1 }));
      console.error(`  arm ${arm.id} (${arm.model}): ${picks.length} picks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { ...arm, picks, usage, ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      console.error(`  ! arm ${arm.id} (${arm.model}) FAILED: ${(err as Error).message}`);
      return { ...arm, picks: [], ok: false, error: (err as Error).message, latencyMs: Date.now() - t0 };
    }
  };

  if (!FALLBACK) return Promise.all(ARMS.map(run));
  const out: ArmResult[] = [];
  for (const arm of ARMS) {
    out.push(await run(arm));
    await new Promise((r) => setTimeout(r, 8000)); // stay under the free-tier rate limit
  }
  return out;
}

export type CouncilPick = {
  ticker: string; votes: number; rankPoints: number; meanConfidence: number;
  theses: { arm: string; rank: number; confidence: number; thesis: string }[];
  rank: number;
};

/**
 * Deterministic vote aggregation (PREREGISTRATION.md §4): votes desc,
 * then mean rank points desc, then ticker asc. No model performs the synthesis.
 */
export function aggregate(live: ArmResult[], limit = PICKS_PER_ARM): CouncilPick[] {
  const tally = new Map<string, { votes: number; rp: number; conf: number; theses: any[] }>();
  for (const arm of live) {
    for (const p of arm.picks) {
      const e = tally.get(p.ticker) ?? { votes: 0, rp: 0, conf: 0, theses: [] };
      e.votes++;
      e.rp += 9 - p.rank;
      e.conf += p.confidence;
      e.theses.push({ arm: arm.id, rank: p.rank, confidence: p.confidence, thesis: p.thesis });
      tally.set(p.ticker, e);
    }
  }
  return [...tally.entries()]
    .map(([ticker, e]) => ({
      ticker,
      votes: e.votes,
      rankPoints: Number((e.rp / e.votes).toFixed(3)),
      meanConfidence: Number((e.conf / e.votes).toFixed(2)),
      theses: e.theses,
    }))
    .sort((a, b) => b.votes - a.votes || b.rankPoints - a.rankPoints || a.ticker.localeCompare(b.ticker))
    .slice(0, limit)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

/** Mean pairwise Jaccard distance between arms' pick sets. Exploratory only. */
export function disagreementRate(live: ArmResult[]): number | null {
  const sets = live.map((a) => new Set(a.picks.map((p) => p.ticker)));
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
