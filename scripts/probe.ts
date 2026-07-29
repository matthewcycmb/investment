// One minimal model call, timed. Used to tell a slow network apart from a
// concurrency problem when the council times out in CI but not locally.
import { streamObject } from 'ai';
import { z } from 'zod';
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const model = process.argv[2] ?? 'openai/gpt-5.6-sol';
const t0 = Date.now();
try {
  const res = streamObject({
    model, schema: z.object({ ok: z.string() }),
    prompt: 'Reply with ok="yes".',
  });
  for await (const _ of res.partialObjectStream) { /* drain */ }
  await res.object;
  console.log(`PROBE ok   ${model}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (err) {
  console.log(`PROBE FAIL ${model}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${(err as Error).message.slice(0, 90)}`);
  process.exitCode = 1;
}
