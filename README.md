# AI Stock Council — a pre-registered forward test

**Question:** can a council of large language models, reading public news and SEC insider filings,
pick S&P 500 stocks that beat SPY over 10 trading days?

**Status:** running. The answer is not known yet, and by design it will be published either way.

Read [PREREGISTRATION.md](./PREREGISTRATION.md) first — it fixes the hypothesis, the method, and the
failure commitment, and it was committed before any pick-generating code existed in this repository.

```
git log --diff-filter=A --format='%ad %H %s' --date=iso -- PREREGISTRATION.md
git log --diff-filter=A --format='%ad %H' --date=iso -- data/picks/
```

If the first is not strictly earlier than the second, this project's central claim is void.

---

## What makes this different from every other "AI picks stocks" project

- **Forward-only. No backtests, ever.** Frontier models were trained on the periods anyone would
  backtest against, so a historical "prediction" is contaminated by lookahead and proves nothing.
- **Pre-registered.** One primary metric, declared before any data existed, evaluated exactly once
  at n=100. Everything else is labelled exploratory and cannot be used to claim success.
- **Losers are published.** Every pick ever generated stays in the record.
- **Tamper-evident.** Picks are committed by CI before their outcomes exist. The git history is the
  audit trail — an edited pick is a visible diff, forever.
- **No discretion after entry.** Equal weight, fixed 10-session horizon, no stops, no early exits.
- **Simulated only.** No money, no orders, no brokerage account, no funds accepted from anyone.

## Method in one screen

| | |
|---|---|
| Universe | S&P 500, snapshotted at project start and frozen |
| Screen | `2 × distinct Form 4 open-market buyers (35d) + min(8-K disclosure ratio, 3)` → top 20 |
| Arms | 3 frontier models pick independently from an identical brief. **Arm A is the pre-declared single-model control.** |
| Council | Deterministic vote aggregation over the arms — no LLM synthesizer, so no synthesizer bias |
| Entry | Open of the first session *after* the pick is committed |
| Exit | Open 10 sessions later. Nothing is touched in between |
| Benchmark | SPY, bought and sold at the same two opens |
| Primary test | One-sided t-test on excess return, α=0.05, SEs clustered by entry week, evaluated once at n=100 |

## Running it

Requires Node 24+ (scripts are TypeScript, run natively — there is no build step).

```bash
npm ci
node scripts/lib.ts               # statistics self-checks (t-distribution vs published values)
node scripts/settle.ts --selfcheck # entry/exit and holiday-skip self-checks

npm run universe                  # ONCE at project start; snapshot is then frozen
npm run screen -- --dry           # mechanical screen, writes nothing
npm run screen                    # writes data/candidates/YYYY-MM-DD.json

export AI_GATEWAY_API_KEY=...     # https://vercel.com/ai-gateway
node scripts/council.ts --models  # list valid arm model IDs
npm run council -- --dry          # full council run, writes nothing
npm run council                   # writes data/picks/YYYY-MM-DD.json

npm run settle                    # resolve entries/exits, write data/outcomes.json
npm run render                    # build public/index.html
```

Arm models default to Anthropic/OpenAI/Google frontier IDs and are overridable with the `ARM_A`,
`ARM_B`, `ARM_C` environment variables (set as GitHub Actions *variables*, not secrets — which model
was used is part of the public record).

## Data sources

All free, no paid vendor:

- **SEC EDGAR** — Form 4 insider transactions and 8-K counts, via `data.sec.gov/submissions`.
  Requires a `User-Agent` header with a contact email; EDGAR blocks requests without one.
- **Yahoo Finance chart endpoint** — daily OHLC bars. Unofficial and unversioned; if it breaks,
  swap `bars()` in `scripts/lib.ts` for Alpaca's free market-data tier (needs a free key).
- **S&P 500 constituents** — snapshotted once from a public dataset, then frozen.

## Cost

Roughly $2–5/week in tokens (four calls per week, not per ticker). Data and hosting are free.

## Automation

- `.github/workflows/pick.yml` — Sunday 00:00 UTC: screen → council → settle → render → commit.
- `.github/workflows/settle.yml` — 22:00 UTC Tue–Sat: settle → render → commit.

Both run the self-checks first and fail before spending tokens if the arithmetic is broken.

---

**Nothing here is investment advice.** This is a research project using simulated positions.
