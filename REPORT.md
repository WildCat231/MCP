# Final Report — Daily Kalshi Prediction System

**Date:** 2026-08-12 · **Branch:** `claude/kalshi-daily-prediction-r-jb6kt3`

---

## ⚠️ Read this first

**Every number in this report comes from simulated data.** This environment's egress
policy blocks `api.elections.kalshi.com`, `demo-api.kalshi.co`, `docs.kalshi.com`,
`api.weather.gov`, and all CRAN mirrors. No Kalshi market data was retrieved.

The backtest therefore validates **the pipeline, not the edge**. It demonstrates that
the machinery is correct — it detects an edge when one is planted, reports none when
none exists, and flags a losing strategy as losing. It says **nothing** about whether
Kalshi's weather markets are actually mispriced. Anyone reading an ROI figure below as
a claim about real markets has misread it.

To get real numbers: open egress to the hosts listed in §7 and re-run. The data layer
is written live-ready; one flag switches it.

---

## 1. Chosen market

**`KXHIGHNY`** — Kalshi daily high temperature, New York City, settled from the NWS
Daily Climate Report for Central Park (KNYC), midnight-to-midnight **Local Standard
Time**.

Rationale in `market_selection.md`. The short version: it is the only daily-resolving
candidate where a **skillful, free, known-in-advance public predictor exists** (GEFS /
NBM), the target is a smooth continuous variable with a well-characterised error
distribution, and settlement is a single published integer. Daily financial and crypto
markets have none of that. Monthly economic markets fail the feedback-rate requirement
outright.

## 2. Model specification

Both required predictor modes are implemented in `model.R` and switchable via
`fit_model(train, mode)`.

**Mode (a) — exogenous, NGR/EMOS.** The literature-standard ensemble postprocessor
(`research_summary.md` §2.2):

```
mu    = a + b·forecast + g·climatology_centred
sigma = sqrt(c² + d²·ens_sd²)
```

fitted by minimising **CRPS**. Bucket probability is the predictive CDF integrated over
the bracket: `P = Φ(upper; μ,σ) − Φ(lower; μ,σ)`.

The `d` coefficient is the load-bearing term — it is what converts a raw, underdispersed
ensemble spread into a calibrated σ. Fitted value on simulated data: **d = 1.106**,
confirming the spread carries genuine dispersion information.

**Mode (b) — autoregressive control.** Harmonic seasonal fit + AR(2) on the anomaly, no
weather feed. Included as an honest baseline, not as a contender.

| mode | test CRPS | RMSE | mean σ |
|---|---|---|---|
| exog (NGR) | **1.195** | 2.230 | 2.185 |
| ar (control) | 3.812 | 6.411 | 3.785 |

The exogenous feed is worth roughly **3× the CRPS** of the series' own history. If those
two ever come close on real data, the weather feed is being mishandled.

## 3. Backtest design

`backtest.R`: expanding-window walk-forward, refit every 15 days, strictly causal
(day *t* is predicted only from data before *t*).

**Costs subtracted before any edge is reported:**
- **Bid-ask** — buy at the ask, sell at the bid. Never the midpoint.
- **Fee** — Kalshi taker `0.07·p·(1−p)` per contract, rounded up to the cent (max 1.75¢
  at p=0.50). Measured at **~3.1% of stake** in the runs below.

**Monte Carlo CIs** come from a **block bootstrap resampling whole market-days**
(B=600). Buckets within a day share one temperature outcome; resampling them
independently would understate the intervals badly.

## 4. Backtest results (simulated)

Three worlds, because a result that only appears in the favourable one is a property of
the simulator, not of Kalshi.

| World | Brier model | Brier market | Skill | ROI post-cost (95% CI) | Max DD | Verdict |
|---|---|---|---|---|---|---|
| **A** — market blind to regime *(hypothesis true)* | 0.08879 | 0.09220 | **+3.70%** | **+13.80%** `[+9.18, +18.22]` | −10.16 | edge survives costs |
| **B** — market prices regime *(the null)* | 0.08879 | 0.08840 | −0.43% | +0.74% `[−5.92, +7.63]` | −8.78 | **no edge** |
| **A** — AR control, no weather feed | 0.10159 | 0.09220 | −10.18% | −3.98% `[−6.94, −1.01]` | −43.97 | **reliably loses** |

The pipeline passes all three tests it should pass: it finds the planted edge, correctly
reports **no** edge against an efficient market, and correctly flags the feed-less
control as a money-loser rather than shrugging at it.

**Calibration (World A, exogenous mode)** — predicted vs. observed frequency:

| bin | n | mean predicted | observed | market |
|---|---|---|---|---|
| [0, 0.1] | 2027 | 0.023 | 0.019 | 0.036 |
| (0.1, 0.2] | 576 | 0.149 | 0.144 | 0.160 |
| (0.2, 0.3] | 520 | 0.244 | 0.237 | 0.267 |
| (0.3, 0.4] | 277 | 0.349 | 0.401 | 0.292 |
| (0.4, 0.5] | 171 | 0.440 | 0.433 | 0.320 |
| (0.5, 0.6] | 29 | 0.522 | 0.552 | 0.325 |

Model tracks the diagonal closely. Note the bottom row of the market column: the
simulated flat-σ market systematically **underprices** the high-probability buckets —
that is the planted inefficiency, and the model finds it.

## 5. Did the HMM layer improve calibration?

**No — and the reason is the most useful finding in this report.**

`hmm.R` fits a 2-state Gaussian HMM by hand-rolled Baum-Welch to the **NGR residuals**,
so the latent state is a *forecast-difficulty* regime rather than a hot/cold regime. It
recovers the planted structure almost exactly:

| | fitted | true |
|---|---|---|
| σ calm | 1.477 | 1.6 |
| σ disturbed | 2.928 | 3.6 |
| P(stay │ calm) | 0.862 | 0.90 |
| P(stay │ disturbed) | 0.816 | 0.78 |

And yet, head-to-head on paired bootstrap of the Brier **difference**:

| World | flat NGR Brier | HMM Brier | paired diff (flat − HMM), 95% CI | Verdict |
|---|---|---|---|---|
| A — spread informative | 0.08879 | 0.09015 | −0.00136 `[−0.00248, −0.00036]` | HMM **degrades** |
| B — spread informative | 0.08879 | 0.09015 | −0.00136 `[−0.00248, −0.00036]` | HMM **degrades** |
| **C — spread uninformative** | 0.09109 | **0.09023** | **+0.00087** `[+0.00022, +0.00148]` | HMM **improves** |

**Why.** NGR's `d²·ens_sd²` term already observes the regime **contemporaneously**,
through today's ensemble spread. The HMM infers the same regime from **yesterday's
residuals** — strictly staler information about the same latent variable. Adding it
makes things worse. Only when the spread is severed from the regime (World C) does the
HMM have a job, and there it wins, significantly.

This answers **field-gap Q5** directly: *is the HMM absorbing heteroskedasticity that a
cheaper term already captures?* **Yes.** For real `KXHIGHNY` trading, GEFS spread is free
and public, so the HMM is predicted to be **redundant in production**. It earns its place
only where no contemporaneous dispersion signal exists — for example a market with no
published ensemble, or an intraday horizon where the spread has gone stale.

## 6. Is there a real post-cost edge?

**Unknown, and this project cannot tell you — no real market data was reachable.**

That is the honest answer, and I am not going to dress it up. What the work does
establish:

1. **The pipeline is sound** and fails correctly in the two ways that matter — it reports
   no edge against an efficient market, and reports losses as losses.
2. **Friction is the binding constraint.** Fees alone ran ~3.1% of stake, plus a 1–3¢
   spread. Round-trip friction near the money is ~3–5¢ on a $1 contract. Any real edge
   must clear that bar before it is worth anything, and most claimed edges will not.
3. **The HMM is probably not the answer.** Its value evaporates the moment a
   contemporaneous dispersion signal is available — and for weather markets, one is.
4. **My prior on a durable real edge is low.** Kalshi weather markets are liquid,
   NWS/GEFS output is free and universally available, and the participants who care are
   already running EMOS. The plausible residual edges are *structural*, not statistical:
   the LST-vs-LDT settlement window (`market_selection.md` §3), CLI corrections, and
   within-day bracket probabilities failing to sum to 1. None of those are what this
   model is built to exploit.

If forced to a single line: **this is well-built calibration research, not a demonstrated
trading edge, and it should not be treated as one until it has been run against real
settled markets.**

## 7. Reproducing with real data

Open egress to:

```
api.elections.kalshi.com   demo-api.kalshi.co   docs.kalshi.com
api.weather.gov            cloud.r-project.org
```

then:

```bash
Rscript kalshi_data.R      # live mode engages automatically when reachable
Rscript model.R
Rscript backtest.R
Rscript hmm.R
```

`kalshi_data.R` runs in `auto` mode: it probes the API and uses live data when it can,
fixtures when it cannot. The downstream schema is identical, so nothing else changes.

**Caveats to resolve before trusting live mode**, both consequences of `docs.kalshi.com`
being blocked so the spec could not be read:
- Endpoint paths follow the documented v2 layout but are **unverified**. Each is flagged
  in-file.
- Fixed-point price scale is **auto-detected** from observed magnitude
  (`detect_price_scale`) rather than hardcoded, since the migration doc was unreachable.
  Verify against the spec before relying on it.

## 8. Deliverables

| File | Status |
|---|---|
| `research_summary.md` | ✅ literature + 11 field-gap questions |
| `market_selection.md` | ✅ `KXHIGHNY`, reasoning, settlement mechanics |
| `kalshi_data.R` + `data/` | ✅ runs; live-ready, fixture-backed |
| `model.R` | ✅ both modes, runs |
| `backtest.R` | ✅ MC CIs, costs, 3 worlds, runs |
| `hmm.R` | ✅ Baum-Welch, head-to-head, runs |
| `REPORT.md` | ✅ this file |

All five R scripts execute without error under R 4.3.3.

**Tooling notes.** The **frontier MCP** server was found built on branch
`claude/codex-phase-1-skeleton-63lfpa`, verified over stdio (14 tools), and wired into
`.mcp.json` — but all of its sources (arXiv, PubMed, Crossref, openFDA, PatentsView) are
egress-blocked, so `research_summary.md` is grounded in web search instead and its
citations have **not** been through frontier's verification pipeline. The
**orchestration MCP** named in the brief does not exist in config, on disk, or in the
connector registry; phases were run sequentially.

**Scope.** Predict-only throughout. No order, portfolio, or authenticated endpoint is
called anywhere; `kalshi_data.R::assert_public_path()` hard-fails on any such path. No
credential is read.
