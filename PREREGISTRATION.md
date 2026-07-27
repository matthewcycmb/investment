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

- Per-model leaderboard (Arm A vs Arm B vs Arm C)
- Council vs single-model control (Arm A)
- Directional hit rate
- Sharpe ratio
- Sector, market-cap, or insider-signal-strength breakdowns
- Inter-arm disagreement rate, and any relationship between disagreement and realised volatility

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

2. **Abnormal disclosure volume.** Count of `8-K` filings by the issuer in the trailing 35 days,
   divided by that issuer's mean 35-day 8-K rate over the trailing 365 days. Score contribution:
   `min(ratio, 3)`. 8-K filings are the SEC-mandated disclosure of material corporate events and
   are used here as a free, auditable proxy for news flow.

Total score = (1) + (2). The top 20 by score become candidates; ties broken by ticker alphabetically.
Tickers with zero insider purchases **and** a disclosure ratio below 1.0 are never eligible.

*Operationalisation note: components (1) and (2) were specified in prose in the initial commit and
made numerically exact in this amendment. The amendment is dated before any screen code was written
and before any pick or price data existed in this repository — verify with `git log`. No further
changes to the screen definition will be made once the first pick is committed.*

The screen code is committed and changes to it are visible in git history. **No ticker is ever added
or removed by hand.**

**Arms.** All four arms receive identical candidate briefs in a single call each week:

| Arm | Role |
|---|---|
| A | Single frontier model, deciding alone — **pre-declared as the control** |
| B | Second frontier model, deciding alone |
| C | Third frontier model, deciding alone |
| **Council** | Deterministic vote aggregation over A, B, C — **the arm the primary test measures** |

Each arm returns its top 8 picks, ranked, with a written thesis. The exact gateway model ID for
every arm is recorded in every pick file. If a provider deprecates a model mid-study, the
replacement ID is recorded and the substitution noted; the study continues rather than restarting.

**Council aggregation is mechanical, not model-driven.** For each ticker:
- `votes` = number of arms (of A, B, C) that selected it
- `rankPoints` = mean of `9 − rank` over the arms that selected it (a 1st-place pick scores 8)

Council picks are the top 8 by `votes` descending, then `rankPoints` descending, then ticker
alphabetically. No language model performs the synthesis.

*Rationale, recorded in advance: if an LLM were the synthesizer, whichever model filled that role
would bias the Council arm toward its own reasoning style — a confound sitting directly on the
primary test. A fixed arithmetic rule cannot be tuned after seeing outcomes. This aggregation was
specified before any pick existed; verify with `git log`.*

Each arm also emits a 1–10 confidence per pick. **Confidence is recorded but never used for
position sizing** — every position is equal-weight regardless. It exists only as exploratory data
on whether models know when they are right.

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
