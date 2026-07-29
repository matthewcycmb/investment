// Isolates why the council times out in CI but not locally.
// A: one realistic-sized call.  B: four concurrent realistic calls.
import { streamObject } from 'ai';
import { z } from 'zod';
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const S = z.object({
  findings: z.array(z.object({
    ticker: z.string(), verdict: z.enum(['BUY', 'SELL', 'HOLD']),
    confidence: z.number().int(), evidence: z.array(z.string()).max(3),
    risk: z.string(), reasoning: z.string(),
  })).max(5),
});

// Roughly the shape and size of a real council brief.
const PROMPT = `You are the FUNDAMENTALS analyst. Judge on business economics only.

EVENTS (7):
${Array.from({ length: 7 }, (_, i) =>
  `- [filing] Company ${i}: Results of Operations and Financial Condition, quarterly earnings released`).join('\n')}

ALLOWED TICKERS:
${['IBM', 'DLR', 'ACN', 'ADBE', 'CPRT', 'OXY', 'JPM', 'SPG'].map((t) =>
  `${t} - sector Technology - last 250.00 - 1d +1.2% - 30d +4.0% - RSI 55`).join('\n')}

Give verdicts with evidence, a counter-case and reasoning.`;

async function one(model: string, tag: string) {
  const t0 = Date.now();
  try {
    const res = streamObject({ model, schema: S, prompt: PROMPT });
    for await (const _ of res.partialObjectStream) { /* drain */ }
    const o = await res.object;
    return `${tag} ok   ${model.padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${o.findings.length} findings`;
  } catch (e) {
    return `${tag} FAIL ${model.padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${(e as Error).message.slice(0, 60)}`;
  }
}

const MODELS = ['anthropic/claude-opus-5', 'openai/gpt-5.6-sol', 'alibaba/qwen3.7-max', 'moonshotai/kimi-k2.5'];

console.log('A. ONE realistic call, sequential');
console.log('  ' + await one(MODELS[0], 'A'));

console.log('\nB. FOUR concurrent, same as the council');
const t0 = Date.now();
const out = await Promise.all(MODELS.map((m) => one(m, 'B')));
out.forEach((l) => console.log('  ' + l));
console.log(`  wall clock ${((Date.now() - t0) / 1000).toFixed(1)}s`);
