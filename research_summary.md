# Research Summary — ML for Daily-Resolving Prediction Markets

**Date:** 2026-08-12
**Scope:** Where a statistical/ML edge plausibly exists in daily-resolving Kalshi markets.

---

## 0. Provenance and a caveat on method

The task specified using the **frontier MCP** server to verify the research frontier. Status:

- The frontier server **exists and is built** (branch `claude/codex-phase-1-skeleton-63lfpa` of this repo; 14 tools, verified stdio handshake). It is now wired in `.mcp.json`.
- It was **not usable for this document**. Every one of its sources is blocked by this environment's egress policy. A live call returns:
  `403 Forbidden: Host not in allowlist: export.arxiv.org`
- The **orchestration MCP** named in the task is not present in config, on disk, or in the connector registry. Phases below were therefore run sequentially.

Consequently the citations here come from **web search**, not from frontier's independence-scored, conflation-checked verification pipeline. They have *not* been through §6 of the frontier spec. Treat status as `single_source`/`unverified` unless you re-run them through `verify_claim` once egress is opened. Claims below are labelled by confidence.

---

## 1. The core question

A prediction market price *is already a forecast*. Beating it requires one of three things — nothing else counts:

1. **An information edge** — you see a predictor the market has not yet absorbed.
2. **A calibration edge** — the market sees the same information but maps it to probability badly.
3. **A structural edge** — mechanical mispricing (stale quotes, bucket-sum violations, settlement-rule detail).

For daily weather markets, (1) is largely closed: NWS/GEFS output is public and free, and the serious participants ingest it. The realistic targets are **(2)** and **(3)**.

## 2. What the literature actually supports

### 2.1 Prediction markets are well-calibrated but not perfectly so
Prediction markets aggregate information efficiently, yet ML reweighting of contributors measurably improves on the raw market. Atanasov et al. showed a 43-feature model identifying accurate forecasters produced measurable AUC gain over the overall market ([medRxiv](https://www.medrxiv.org/content/10.1101/2023.01.19.23284578v1.full.pdf), [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10502359/)).

**Implication:** residual miscalibration exists, but it is *small*. Any backtest reporting a large edge is far more likely to have a leakage bug than a discovery. **Confidence: moderate.**

### 2.2 Statistical postprocessing of ensembles is a solved, high-value technique
**This is the single most transferable result for our purpose.** Raw ensemble forecasts are biased and *underdispersed* — their spread understates true uncertainty. EMOS / Nonhomogeneous Gaussian Regression (NGR) fixes both:

> predictive distribution `N(μ, σ²)` with `μ = a + b·(ensemble mean)` and `σ = c + d·(ensemble sd)`

Fitted by minimising CRPS. Extensions add local climatology, spatial correlation, skew, and lead-time continuity ([Scheuerer & Büermann 2014, arXiv:1407.0058](https://arxiv.org/abs/1407.0058); [MWR 143(3)](https://journals.ametsoc.org/view/journals/mwre/143/3/mwr-d-14-00210.1.xml); [Wessel et al. 2024, QJRMS](https://rmets.onlinelibrary.wiley.com/doi/10.1002/qj.4701); [MOGREPS-UK skew, MWR](https://journals.ametsoc.org/view/journals/mwre/149/8/MWR-D-20-0422.1.pdf)).

**Why this matters here:** a Kalshi temperature bracket is exactly `P(L < T ≤ U)`. Given a calibrated predictive distribution, that probability is a difference of two CDF evaluations. NGR is *the* right model class for this problem — not a generic classifier. **Confidence: high.** This is textbook operational meteorology.

### 2.3 Regime-switching genuinely appears in temperature series
Two-state regime-switching temperature models reproduce degree-day distributions better than single-regime stochastic processes, and HMM/Baum-Welch calibration is established for temperature dynamics and weather derivatives ([Regime-Switching Temperature Dynamics, arXiv:1808.04710](https://arxiv.org/pdf/1808.04710); [higher-order HMM temperature, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1877750316301466); [Baum-Welch regime calibration, arXiv:0904.1500](https://arxiv.org/pdf/0904.1500)).

The relevant latent variable for *us* is subtler than "hot/cold". It is the **forecast-error regime**: synoptic situations where NWS guidance is reliable (settled ridge) versus situations where it is not (frontal passage, marine-layer timing, convective outflow). If σ is regime-dependent and the market applies a flat σ, that is a calibration edge of exactly the kind §2.1 permits. **Confidence: moderate — this is the project's actual hypothesis, and it is the thing the backtest must test rather than assume.**

### 2.4 Costs dominate at these price levels
Kalshi taker fee ≈ `0.07 × p × (1−p)` per contract, maxing at **1.75¢ at p=0.50**; maker fees ~25% of taker ([pm.wiki](https://pm.wiki/learn/kalshi-fees-explained), [Maker/Taker math](https://whirligigbear.substack.com/p/makertaker-math-on-kalshi)).

Add a typical 1–3¢ bid-ask spread. **Round-trip friction near the money is ~3–5¢ on a $1 contract.** A model must beat the market by *more than that* to be worth anything. This single fact kills most naive "edge" claims and is why the backtest subtracts costs before reporting anything.

Note the fee curve is convex-toward-the-middle: it is cheapest at the extremes. Combined with the favorite-longshot literature, this argues for hunting edge in **confident** (tail) buckets, not coin-flip ones.

### 2.5 Settlement detail is a real, underrated source of edge
Kalshi daily temperature markets settle on the **NWS Daily Climate Report (CLI)** for a named station, midnight-to-midnight **Local Standard Time** ([Kalshi Help](https://help.kalshi.com/en/articles/13823837-weather-markets)). LST — not local *daylight* time. Tickers are `KXHIGH<CITY>` / `KXLOW<CITY>`.

Three exploitable consequences:
- The settlement window is offset by an hour from "the day" during DST, so a late-evening or early-morning temperature spike can land in the neighbouring market-day.
- Settlement uses the **station** value, not a gridded or metro-average value.
- Preliminary CLI values can be **corrected**; the *final* CLI governs.

**Confidence: high** on the mechanism, **unverified** on how much money it is worth.

## 3. Ranking of candidate daily markets

| Market | Feedback rate | Public predictor | Edge type available | Verdict |
|---|---|---|---|---|
| **Daily city high temp** (`KXHIGH*`) | ~20 city-days/day | GEFS/NBM/NWS, free | calibration + settlement | **Selected** |
| Daily index up/down | 1/day/index | none of value | ~none (EMH) | rejected |
| Daily crypto range | high | none of value | ~none, high fee tier | rejected |
| Monthly economic | 1/month | consensus | too slow to validate | out of scope |

Temperature wins on the criterion that matters: **a genuinely skillful, free, known-in-advance exogenous predictor exists**, and the target is a smooth continuous variable with a well-understood error distribution. Financial daily markets have neither.

## 4. Field-gap question list

Framed as questions, per the field-gap method. (The `field-gap` skill itself requires frontier MCP and could not be run — these are derived by hand from the same framing.)

**On calibration**
1. Is Kalshi's implied temperature distribution underdispersed in the same way raw ensembles are — and if so, does the underdispersion persist *after* the market has seen the NBM?
2. Do the bracket probabilities across one city-day sum to something ≠ 1 after spread adjustment, and is the residual tradeable?
3. Is there a favorite-longshot bias in temperature brackets specifically, where tail buckets are systematically overpriced?

**On regimes**
4. Can a latent state fitted only to *forecast-error* history (not temperature level) predict tomorrow's forecast reliability better than lead time alone?
5. Do regime transitions align with identifiable synoptic events, or is a fitted HMM just absorbing heteroskedasticity a GARCH term would capture more cheaply?
6. **Does the market itself already price the regime?** If market-implied σ widens ahead of frontal passages, the HMM edge is already arbitraged away.

**On microstructure**
7. How quickly does the price impound each NBM/GEFS cycle — minutes or hours? The answer sets the entire viability of a latency-free strategy.
8. What is the realistic fillable size at the inside quote, and does edge survive being a price-taker at depth?

**On settlement**
9. How often does the LST-vs-LDT window offset change the settled bucket, and does the market price that offset correctly on the affected days?
10. How often do preliminary CLI values get corrected in a way that flips a bucket?

**The honest meta-question**
11. Given that ~2–4¢ of round-trip friction and a large, sophisticated participant set both exist, what is the *prior* probability that any edge survives costs — and is this project better understood as calibration research than as a trading strategy?

Question 11 is the one this repo is actually built to answer, and the report is required to answer it in the negative if that is what the numbers say.

## 5. What this implies for the build

1. **Model class:** NGR/EMOS with a bucket-CDF link — not a generic classifier. §2.2.
2. **Benchmark:** the market price, not a naive baseline. Beating climatology is meaningless.
3. **Metric:** Brier + reliability curve, with Monte Carlo CIs. Point estimates on ~100 days are noise.
4. **Costs first:** subtract spread + `0.07·p·(1−p)` before any edge is reported. §2.4.
5. **HMM must earn its place:** head-to-head against the flat model. Report it as a loss if it loses. §2.3.
