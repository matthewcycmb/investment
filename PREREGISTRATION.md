# Pre-Registration

**Committed: 2026-07-27, before any pick-generating code existed in this repository.**

Verify this claim yourself:

```
git log --diff-filter=A --format='%ad %H %s' --date=iso -- PREREGISTRATION.md
git log --diff-filter=A --format='%ad %H' --date=iso -- data/picks/
```

If the first commit is not strictly earlier than every file under `data/picks/`, this
pre-registration is void and nothing in this repository should be believed.

---

## 1. The question

Can a council of large language models, reading public news and SEC insider filings, select
S&P 500 stocks that outperform the S&P 500 itself over a 10-trading-day horizon?

This is a forward test. **No backtesting is performed anywhere in this project.** Frontier language
models are trained on data covering the historical periods anyone would backtest against, so a
historical "prediction" is contaminated by lookahead and is worthless as evidence. Every
observation in this study is generated before its outcome exists.

## 2. Primary hypothesis — the only test that can declare success

> **H₁:** The mean 10-trading-day excess return of Council-arm picks, measured against SPY over
> identical windows, is greater than zero.

- **H₀:** mean excess return ≤ 0
- **Test:** one-sample, one-sided t-test on per-pick excess returns
- **α = 0.05**
- **n = 100 closed Council-arm picks**
- **Evaluated exactly once**, at the moment the 100th pick closes.

There is no second look. If the test does not reject H₀ at n=100, the study has failed to
demonstrate the effect, and that is the published result. The study is not extended, re-run,
re-scoped, or re-tested on a different metric in search of significance.

### Known statistical limitation, declared in advance

Picks are generated weekly and held for 10 trading days, so the holding windows of consecutive
weeks overlap by roughly half. Per-pick outcomes are therefore **not independent**, and a naive
t-test will understate the standard error.

Mitigation: the primary test uses standard errors **clustered by entry week**. With approximately
13–20 clusters this estimator is itself imprecise, and no clean fix exists at this sample size.

Both the naive and the week-clustered p-value are published. The **week-clustered p-value is the
primary one.** Publishing both is deliberate — so that the weaker number cannot be quietly
selected after the fact.

## 3. Exploratory measures — may never be used to claim success

The following are reported for interest and will be labelled EXPLORATORY on the site. None of them
can be substituted for the primary test, and none will be cited as evidence that the method works:

- Per-specialist leaderboard (which analytical lens is most often right)
- Whether the debate round changes outcomes: did revised verdicts beat unrevised ones
- How often a specialist changes position when shown the counter-cases
- Directional hit rate
- Sharpe ratio
- Sector, market-cap, or insider-signal-strength breakdowns
- Inter-specialist disagreement rate, and any relationship between disagreement and realised volatility
- Whether `SELL` verdicts, recorded but never acted on, would have been profitable

*Note: the original design carried a single-model control arm. The specialised structure removes it,
because no specialist now receives the same brief as the council. The council-versus-solo comparison
is therefore no longer available and is not claimed anywhere. This was a deliberate trade, made
before any pick existed: the four-lens structure was chosen over the ability to run that particular
comparison.*

Any of these that looks striking is a hypothesis for a **future, separately pre-registered study**,
not a result of this one.

## 4. Method — frozen

**Universe.** S&P 500 constituents as of project start, snapshotted to `data/universe.json` and
dated. Constituents are not updated mid-study.

**Screen.** Fully mechanical, no human selection. Weekly, each universe ticker is scored on:

1. **Insider cluster buying.** Count of *distinct* reporting owners who filed a Form 4 containing a
   `transactionCode` of `P` (open-market purchase) with a `transactionDate` in the trailing 35
   days. Codes `A` (grant), `M` (option exercise), `F` (tax withholding) and `S` (sale) are
   excluded — only genuine open-market buying counts. Score contribution: `2 × distinct_buyers`.

   A reporting owner counts only if **both** hold:
   - the filing's `<issuerTradingSymbol>` equals the ticker being screened, and
   - that owner's `<reportingOwnerRelationship>` has `isOfficer` or `isDirector` true.

   This excludes filings by corporate entities, affiliates, and pure 10%-owners, and excludes
   filings that cover a different security than the one being screened. "Insider buying" means an
   officer or director buying *that company's* stock; the officer/director subset is also the one
   with documented predictive power in the literature, whereas 10%-owner buying is far weaker.

   *Correction note: the initial implementation counted every reporting owner on a qualifying
   Form 4. Inspection of the first screen output showed this crediting corporate entities as
   "insiders" — e.g. `PRUDENTIAL FINANCIAL INC` against PRU, and a Blackstone fund's own shares
   (≈$26) against BX (≈$150). That is a defect relative to the stated intent, not a threshold
   choice, and it was corrected before any pick existed. No outcome data existed at the time of
   this correction; verify with `git log`.*

2. **Abnormal disclosure volume.** Count of `8-K` filings by the issuer in the trailing 35 days,
   divided by that issuer's mean 35-day 8-K rate over the trailing 365 days. Score contribution:
   `min(ratio, 3)`. 8-K filings are the SEC-mandated disclosure of material corporate events and
   are used here as a free, auditable proxy for news flow.

**Known limitation of component (1), recorded before any pick.** The `P` code does not distinguish
discretionary conviction buying from routine director stock-purchase or deferred-compensation plans.
The first screen run surfaced SPG with 11 officer/director "buyers" purchasing 33–187 shares each at
an identical price on the same day — almost certainly a plan, not eleven independent judgements, yet
it scored 22 against a next-best of 4.7. A minimum-dollar threshold would filter this, but the
criterion as written implements exactly what was specified, and adding a threshold *after seeing
which names it surfaces* is the tuning this document exists to prevent. **The rule is left
unchanged.** This limitation is disclosed rather than fixed, and any future change to it must wait
for a separate, separately pre-registered study.

Total score = (1) + (2). The top 20 by score become candidates; ties broken by ticker alphabetically.
Tickers with zero insider purchases **and** a disclosure ratio below 1.0 are never eligible.

*Operationalisation note: components (1) and (2) were specified in prose in the initial commit and
made numerically exact in this amendment. The amendment is dated before any screen code was written
and before any pick or price data existed in this repository — verify with `git log`. No further
changes to the screen definition will be made once the first pick is committed.*

The screen code is committed and changes to it are visible in git history. **No ticker is ever added
or removed by hand.**

**Arms.** Four specialists, each given the *same evidence* but a *different analytical lens*:

| Arm | Model | Specialty |
|---|---|---|
| A | Claude Opus 5 | Fundamentals, accounting, valuation, earnings impact |
| B | ChatGPT 5.6 Sol | Causal reasoning, source verification, adversarial counter-case |
| C | Qwen 3.7 Max | China/Hong Kong context, policy, market sentiment |
| D | Kimi K3 | Long-document synthesis, second-order consequences |

Each returns, per stock: a verdict of `BUY` / `SELL` / `HOLD`, a confidence of 1–10, up to three
evidence claims drawn from the supplied material, and the strongest argument *against* its own
verdict. An empty response is explicitly valid. The exact gateway model ID is recorded in every
pick file; if a provider deprecates a model mid-study the replacement is recorded and noted.

**Council aggregation: a fixed four-step rubric.** Steps 1–3 are pure arithmetic with no model
involved. Step 4 invokes models only when it fires.

1. **Verify the evidence.** A specialist's claim counts as verified when another specialist
   independently asserts a materially overlapping claim. `verified` = the fraction of that
   specialist's claims which are corroborated. Where no second specialist covered the stock,
   `verified` = 0.5 — unknown, not failed.
2. **Weight each vote.** `weight = relevance × (0.5 + 0.5 × verified) × (confidence ÷ 10)`, where
   `relevance` is a fixed multiplier for that specialty against that event type (a policy specialist
   counts for more on a policy event). The relevance table is committed in `scripts/arms.ts` and is
   frozen once the first pick exists.
3. **Measure agreement.** `agreement` = the leading verdict's share of total weight.
4. **Investigate credible disagreement.** If `agreement < 0.75` **and** at least one dissenter has
   `verified ≥ 0.5`, one debate round runs: every specialist sees all positions and counter-cases and
   may revise. Steps 1–3 are then recomputed. An unsupported outlier is noise, not a credible
   objection, and does not trigger a debate. Where the council agrees, no debate is run at all.

**Acting.** A position opens only when the leading verdict is `BUY` **and** `agreement ≥ 0.60`
**and** at least 2 specialists voted `BUY`. `SELL` and `HOLD` never open a position.

**`SELL` verdicts are recorded and published but do not close anything.** Exits remain purely
mechanical (see position rules below). This is deliberate: discretionary exits are the easiest way
to flatter a track record, so the council's sell opinions are captured as data to be scored later
rather than acted on.

*Amendment note: the original design gave every arm an identical brief and aggregated votes with a
pure arithmetic rule. It was replaced with the specialised-role structure and this rubric before any
pick or outcome data existed — verify with `git log`. The rationale for the original choice, that no
language model should perform the synthesis, is preserved: steps 1–3 remain arithmetic, and step 4
lets models revise their own positions but never lets any model aggregate the others' votes.*

**Position rules — no discretion after entry.**
- Equal notional weight on every pick
- Entry price = the **open of the first trading session after the pick is committed**
- Exit price = the **open on the 10th trading day after entry**
- No stop-losses, no trailing stops, no early exits, no position resizing
- A pick, once committed, is never modified or withdrawn

**Benchmark.** SPY, bought and sold at the opens of the exact same two sessions as the pick it is
compared against.

`excess_return = (pick_exit / pick_entry - 1) - (spy_exit / spy_entry - 1)`

## 5. Publication commitment

The result is published on the project's public page at n=100 **whichever way it lands**, with
equal prominence given to a negative result.

Every pick ever generated appears in the public record — winners, losers, and picks that were
still open at evaluation. Nothing is removed, and the git history is the audit trail.

A negative result here would be unsurprising: decades of published evidence show that active stock
selection generally underperforms broad indices after costs. Reporting that outcome honestly is the
point of pre-registering at all.

## 6. Scope and disclaimers

This is a research project using **simulated (paper) positions only**. No money is invested, no
orders are placed, no brokerage account is involved, and no funds are ever accepted from anyone.

Nothing produced by this project is investment advice.
