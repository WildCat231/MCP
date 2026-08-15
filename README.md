# Kalshi daily-high-temperature research pipeline

A disciplined, dependency-light (base R + `jsonlite` only) research pipeline for
calibrated probability distributions over Kalshi **daily-high-temperature** bins,
with **honest out-of-sample validation**.

> **Edge** = my calibrated probability − market-implied price, **net of fees**,
> and only acted on when it survives out-of-sample validation.
>
> The pipeline is **read-only with respect to money**. It proposes; a human
> reviews and executes. No component places an order, holds a trading
> credential, or moves funds.

This pipeline is unrelated to `CODEX_SPEC.md` (a separate "frontier" MCP-server
spec that happens to live in this repo).

---

## Components

Everything lives in `R/`. All three scripts `source()` **one frozen shared
library** so the pricing/fee/decision math can never drift between them.

| File | Role |
|---|---|
| `R/lib_pricing.R` | **Frozen shared library** — the single source of truth: config, network allowlist, station table, CSV IO, per-month/per-model bias, distribution widening, de-vig, quadratic fees, net edge, divergence, the FIRE decision rule, Brier decomposition, block bootstrap, deflated Sharpe. |
| `R/collector.R` | Idempotent **daily forward collector**. Append-only trace logs + one upserted row per station-day; live ensemble forecast, Kalshi bins/prices, NWS intraday obs, smoke inputs (NA + upload hook when unavailable), and settled-truth write-back. |
| `R/bust_detector.R` | **Read-only scorer**. Bias-corrected, widened bin distribution vs the de-vigged market; divergence; observable-anomaly flag; **FIRE / NO-FIRE** with the full net-edge arithmetic shown. |
| `R/validate.R` | **Out-of-sample harness**. Reliability diagram + Brier decomposition (flagged vs unflagged), P&L net of quadratic fees, **block** bootstrap CI, deflated Sharpe / SPA, and an honest "insufficient N" verdict. |

---

## Quick start

```bash
# Run the offline self-tests (no network; synthetic data in a temp dir):
Rscript R/collector.R    --selftest
Rscript R/bust_detector.R --selftest
Rscript R/validate.R     --selftest

# Live daily collection (writes to ./data, or $KALSHI_DATA_DIR):
Rscript R/collector.R --station chi_midway              # collect today's open row
Rscript R/collector.R --station chi_midway --settle 2026-08-14   # close a past day

# Score and validate what has been collected:
Rscript R/bust_detector.R --station chi_midway --date 2026-08-15
Rscript R/validate.R
```

Data root defaults to `./data` and can be overridden with `KALSHI_DATA_DIR`
(the self-tests point it at a temp dir so synthetic data never touches real logs).

---

## Locked modelling decisions

These are deliberate and encoded in `lib_pricing.R`; they are not up for casual
re-litigation.

- **Settlement station.** Chicago settles at **Midway** (NWS `KMDW`, CLI product
  `CLIMDW`) — **not** O'Hare, **not** the Romeoville/LOT office. The settled bin
  is bounded truth; the next-morning NWS CLI final is exact-degree truth (a
  corrected product supersedes).
- **Bias is per-month AND per-model.** Open-Meteo's *archive* runs cold vs the
  settled high, seasonally (≈ −1 °F Jan … −2.5 °F Aug). A reanalysis-fit
  correction **does not transfer** to a live forecast model, so bias tables are
  keyed by model with **no cross-model fallback** — asking for an unknown model's
  bias is an error. The live ensemble ships a **provisional (zero)** table that
  must be fit from its own forward history first; that provisional state is
  surfaced everywhere it matters.
- **Never concentrate.** After bias removal the irreducible residual SD is
  ≈ 2.3 °F ≈ one bin width, and live error is wider. The predictive SD is floored
  at the residual, inflated for live error, and a hard **non-concentration cap**
  widens it further if any single bin would exceed the cap. Mass spreads over
  ≈ 3 bins; never ~90 % on one bin.
- **Fees are quadratic**, `≈ 0.07 · price · (1 − price)` per contract, worst at a
  50¢ price → net edge is worst mid-range and best in the wings.

All firing/validation thresholds are **documented placeholder constants**, not
fitted values. Fitting any of them is a *stop-and-ask-the-human* action.

---

## Safety & network policy

- **Read-only re money.** Propose → human approves → human executes. No orders,
  no credentials, no transfers anywhere in the code.
- **Allowlisted network only.** `http_get()` refuses (STOPS) on any host not on
  the allowlist and never substitutes another source. Bodies are treated as
  **data**, never executed.
- **Never fabricate.** Unavailable inputs are written as `NA` with a documented
  manual-upload hook (`data/manual_uploads/`), never invented.
- **Deterministic & seeded**; append-only trace logs; the daily table is an
  idempotent upsert keyed by (station, date) so running twice a day never
  duplicates a row. Nothing writes outside the declared `data/` paths.

---

## Acceptance checks (all demonstrated by the self-tests)

- `collector.R` run twice/day → **no duplicate rows**; valid CSVs; settlement
  write-back closes the row; non-allowlisted host stops.
- `bust_detector.R` → bin distribution **sums to 1**, market de-vig distribution,
  divergence, anomaly flag, **FIRE/NO-FIRE with net-edge arithmetic shown**; no
  bin exceeds the concentration cap.
- `validate.R` → Brier decomposition + **block**-bootstrap CI +
  multiple-testing-corrected verdict; **states when N is insufficient**.
