# Market Selection — `KXHIGHNY` (NYC Daily High Temperature)

**Selected:** Kalshi series **`KXHIGHNY`** — "Highest temperature in NYC today", daily-resolving, settled from the NWS Daily Climate Report for the New York Central Park station (KNYC).

---

## 1. Why this series

The task requires a daily-resolving, data-rich market where a public forecast gives a modeling edge. Scoring the candidates against that:

| Criterion | `KXHIGHNY` |
|---|---|
| Resolves daily | Yes — one event per calendar day |
| Free known-in-advance predictor | Yes — NWS/NBM point forecast, GEFS ensemble, both public |
| Settlement objectivity | Very high — a single published integer from one station |
| Feedback cycles per month | ~30 per city; ~600/month across all 20 Kalshi cities |
| Modelable error structure | Yes — forecast error is near-Gaussian, well-studied, heteroskedastic |
| Structural quirks to exploit | Yes — LST window, station-specific, CLI corrections |

The decisive property is the **third column of the modeling problem**: the target is a *continuous* variable (temperature) that the market slices into *ordinal buckets*. That converts the whole problem into "estimate a predictive distribution, then integrate it over bucket edges" — a well-posed statistical problem with a century of meteorological literature behind it (see `research_summary.md` §2.2). Daily financial markets offer no comparable structure: there is no public, skillful, known-in-advance predictor of tomorrow's S&P direction.

**NYC specifically** over the other 19 cities:
- Highest expected liquidity of the Kalshi weather cities (largest trader base), so measured spreads are realistic rather than artifacts of a dead book.
- KNYC/Central Park is a long-record, well-documented station.
- Coastal/marine-layer influence produces genuine **regime structure** in forecast error — sea-breeze days are materially harder to forecast than continental-flow days. That is precisely the structure `hmm.R` is built to detect. A purely continental station would be a weaker test of the HMM hypothesis.

## 2. Market structure

Each day Kalshi lists an **event** (one city-day) containing several **markets**, each a temperature bracket:

```
KXHIGHNY-26AUG12-B82.5   →  "82° to 83°"   (bracket, ~2°F wide)
KXHIGHNY-26AUG12-T89.5   →  "89° or above" (tail)
```

Properties that matter for modeling:
- Brackets within a day are **mutually exclusive and collectively exhaustive** — true probabilities sum to 1. This is a hard constraint the model must respect and a testable property of the market (field-gap Q2).
- Bracket width is ~1–2°F near the mode, with wider tail buckets.
- Each bracket is a separate binary market with its own order book, so spreads differ *across buckets within the same day*.

## 3. Settlement — the details that matter

Source: [Kalshi Weather Markets help](https://help.kalshi.com/en/articles/13823837-weather-markets).

1. **Source of truth:** the NWS Daily Climate Report (CLI) for the station. Not METAR, not a gridded product, not Weather.com.
2. **Window:** 12:00 AM – 11:59 PM **Local Standard Time**. During EDT this window is offset one hour from local clock time — a 12:30 AM EDT reading falls in the *previous* market-day.
3. **Timing:** settles the following morning, when the final CLI is issued.
4. **Corrections:** preliminary CLI values can be revised; the final governs.

Point 2 is a genuine, mechanical edge source and is not something a model learns from price history — it must be encoded. `kalshi_data.R` records the settlement window explicitly rather than assuming calendar-day alignment.

## 4. The modeling hypothesis

> The market prices each bracket from a predictive distribution whose **width is close to constant** given lead time, while the true forecast-error width is **regime-dependent**. On high-uncertainty days the market is overconfident (tails underpriced); on low-uncertainty days it is underconfident (tails overpriced).

Falsifiable, and directly tested by `hmm.R` vs `model.R`. If the market already widens its implied σ on hard days, the hypothesis is dead and the report must say so.

## 5. Predictors

**Exogenous mode (`model.R` mode `a`)** — known before resolution:
- NBM/NWS point forecast for the day's high at KNYC
- GEFS ensemble mean and **spread** (the spread is the load-bearing input for NGR)
- Lead time in hours to end of settlement window
- Day-of-year climatology for the station

**Autoregressive mode (`model.R` mode `b`)** — no external feed:
- Lagged realized highs, seasonally adjusted
- Lagged forecast errors (regime persistence)

Mode (b) exists as an honest control: it shows what the series' own history is worth *without* a weather feed. It is expected to lose to mode (a), and if it does not, that is evidence the exogenous feed is being mishandled.

## 6. Data availability constraint (recorded honestly)

This environment's egress policy blocks `api.elections.kalshi.com`, `demo-api.kalshi.co`, `docs.kalshi.com`, and `api.weather.gov`. The data layer is therefore written **live-ready but fixture-backed**: identical downstream schema either way, one flag to switch. All backtest numbers in `REPORT.md` are from **simulated** data and are labelled as such. They validate the *pipeline*, not the *edge*.

## 7. Rejected alternatives

- **`KXHIGH` other cities** — same model, kept as the natural cross-sectional extension; NYC first for liquidity.
- **`KXLOW*`** — overnight lows are arguably *more* regime-dependent (radiational cooling vs. cloud cover), so a good phase-2 target, but thinner books.
- **Daily index up/down** — no skillful public predictor; efficient-market prior says no edge. Rejected.
- **Daily crypto range** — higher fee multiplier, no public predictor. Rejected.
- **Monthly economic releases** — one feedback cycle per month defeats the entire premise. Out of scope per the brief.
