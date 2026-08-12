#!/usr/bin/env Rscript
# =============================================================================
# backtest.R — walk-forward backtest with Monte Carlo confidence intervals
#
# Scores the model against BOTH the realized outcome and the market's implied
# price, and subtracts real trading friction before reporting any edge.
#
# COSTS (research_summary.md §2.4)
#   bid-ask : you buy at the ask, sell at the bid. Never at the midpoint.
#   fee     : Kalshi taker fee = 0.07 * p * (1-p) per contract, rounded up to
#             the cent. Max 1.75c at p=0.50.
#
# MONTE CARLO
#   CIs come from a BLOCK bootstrap resampling whole market-days, not individual
#   buckets. Buckets within a day share one temperature outcome and are strongly
#   dependent; resampling them independently would understate the CI badly.
#
# THE NULL IS RUN TOO
#   main() runs both simulator worlds: one where the market prices a flat sigma
#   (hypothesis true) and one where it already prices the regime (null). A result
#   that only appears in the first world is a property of the simulator, not of
#   Kalshi.
# =============================================================================

suppressPackageStartupMessages({ library(dplyr); library(tibble) })
source("kalshi_data.R")
source("model.R")

BT <- list(
  train_frac  = 0.5,
  refit_every = 15,      # days between refits (bounds parameter staleness)
  min_edge    = 0.02,    # required expected profit per contract, AFTER costs
  n_boot      = 600,
  fee_mult    = 0.07     # Kalshi taker multiplier
)

# ---------------------------------------------------------------------------
# Costs
# ---------------------------------------------------------------------------

kalshi_fee <- function(price, mult = BT$fee_mult) {
  # Fee is charged per contract and rounded UP to the next cent.
  ceiling(mult * price * (1 - price) * 100) / 100
}

# ---------------------------------------------------------------------------
# Walk-forward: expanding window, periodic refit, strictly causal
# ---------------------------------------------------------------------------

ar_refresh <- function(fit, hist) {
  doy  <- as.integer(format(hist$date, "%j"))
  base <- predict(fit$seas, newdata = data.frame(doy = doy))
  fit$last_anom <- tail(hist$realized - base, fit$p)
  fit
}

walkforward <- function(d, mode = "exog") {
  dd    <- daily_frame(d)
  dates <- dd$date
  start <- max(floor(nrow(dd) * BT$train_frac), 90)

  preds <- list(); fit <- NULL
  for (i in seq(start + 1, nrow(dd))) {
    hist <- dd[1:(i - 1), ]                       # everything strictly before day i
    if (is.null(fit) || (i - start - 1) %% BT$refit_every == 0) {
      fit <- tryCatch(fit_model(hist, mode), error = function(e) NULL)
    }
    if (is.null(fit)) next
    f <- if (inherits(fit, "ar_fit")) ar_refresh(fit, hist) else fit
    preds[[length(preds) + 1]] <- predict_model(f, dd[i, , drop = FALSE])
  }
  pred <- bind_rows(preds)

  d |>
    inner_join(pred, by = "date") |>
    mutate(model_prob = bucket_prob(mu, sigma, lower, upper))
}

# ---------------------------------------------------------------------------
# Trading rule + realized PnL
# ---------------------------------------------------------------------------

apply_trades <- function(df, min_edge = BT$min_edge) {
  df |>
    mutate(
      # buy YES at the ask; buy NO at (1 - bid)
      cost_yes  = ask,          fee_yes = kalshi_fee(ask),
      cost_no   = 1 - bid,      fee_no  = kalshi_fee(1 - bid),
      ev_yes    = model_prob        - cost_yes - fee_yes,
      ev_no     = (1 - model_prob)  - cost_no  - fee_no,
      side      = case_when(ev_yes >= min_edge & ev_yes >= ev_no ~ "YES",
                            ev_no  >= min_edge                    ~ "NO",
                            TRUE                                  ~ "NONE"),
      stake     = case_when(side == "YES" ~ cost_yes,  side == "NO" ~ cost_no,  TRUE ~ 0),
      fee       = case_when(side == "YES" ~ fee_yes,   side == "NO" ~ fee_no,   TRUE ~ 0),
      pnl       = case_when(side == "YES" ~ outcome       - cost_yes - fee_yes,
                            side == "NO"  ~ (1 - outcome) - cost_no  - fee_no,
                            TRUE          ~ 0)
    )
}

max_drawdown <- function(pnl_by_day) {
  eq   <- cumsum(pnl_by_day)
  peak <- cummax(c(0, eq))[-1]
  min(eq - peak)            # <= 0
}

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

metrics <- function(df) {
  tr <- df |> filter(side != "NONE")
  by_day <- tr |> group_by(date) |> summarise(p = sum(pnl), .groups = "drop") |> arrange(date)
  list(
    n_obs         = nrow(df),
    brier_model   = mean((df$model_prob   - df$outcome)^2),
    brier_market  = mean((df$implied_prob - df$outcome)^2),
    logloss_model = -mean(df$outcome * log(df$model_prob) +
                          (1 - df$outcome) * log(1 - df$model_prob)),
    n_trades      = nrow(tr),
    total_pnl     = sum(tr$pnl),
    total_staked  = sum(tr$stake),
    total_fees    = sum(tr$fee),
    roi           = if (sum(tr$stake) > 0) sum(tr$pnl) / sum(tr$stake) else NA_real_,
    max_dd        = if (nrow(by_day)) max_drawdown(by_day$p) else NA_real_
  )
}

# Block bootstrap over whole market-days
mc_ci <- function(df, B = BT$n_boot, level = 0.95, seed = 7) {
  set.seed(seed)
  days <- unique(df$date)
  keys <- c("brier_model", "brier_market", "roi", "max_dd", "n_trades")
  draws <- matrix(NA_real_, B, length(keys), dimnames = list(NULL, keys))
  for (b in seq_len(B)) {
    samp <- sample(days, length(days), replace = TRUE)
    # index-join preserves duplicated days (a plain filter would collapse them)
    idx  <- unlist(lapply(samp, function(dt) which(df$date == dt)), use.names = FALSE)
    m    <- metrics(df[idx, , drop = FALSE])
    draws[b, ] <- unlist(m[keys])
  }
  a <- (1 - level) / 2
  as.data.frame(t(apply(draws, 2, quantile, probs = c(a, 0.5, 1 - a), na.rm = TRUE)))
}

calibration_curve <- function(df, bins = 10) {
  cut_pts <- seq(0, 1, length.out = bins + 1)
  df |>
    mutate(b = cut(model_prob, cut_pts, include.lowest = TRUE)) |>
    group_by(b) |>
    summarise(n = n(), mean_pred = mean(model_prob), obs_freq = mean(outcome),
              mean_mkt = mean(implied_prob), .groups = "drop") |>
    filter(n >= 20)
}

# ---------------------------------------------------------------------------
# One full scenario
# ---------------------------------------------------------------------------

run_scenario <- function(label, market_knows_regime, mode = "exog", n_days = 900) {
  d  <- simulate_market_days(n_days = n_days, market_knows_regime = market_knows_regime)
  wf <- walkforward(d, mode = mode)
  tr <- apply_trades(wf)
  m  <- metrics(tr)
  ci <- mc_ci(tr)

  cat(sprintf("\n================ %s  [mode=%s] ================\n", label, mode))
  cat(sprintf("test rows            : %d over %d market-days\n", m$n_obs, length(unique(tr$date))))
  cat(sprintf("Brier  model         : %.5f   [%.5f, %.5f]\n",
              m$brier_model, ci["brier_model", 1], ci["brier_model", 3]))
  cat(sprintf("Brier  market        : %.5f   [%.5f, %.5f]\n",
              m$brier_market, ci["brier_market", 1], ci["brier_market", 3]))
  cat(sprintf("Brier  skill vs mkt  : %+.2f%%  (positive = model better)\n",
              100 * (1 - m$brier_model / m$brier_market)))
  cat(sprintf("trades taken         : %d of %d rows (%.1f%%)\n",
              m$n_trades, m$n_obs, 100 * m$n_trades / m$n_obs))
  cat(sprintf("staked / fees        : %.2f / %.2f  (fees = %.1f%% of stake)\n",
              m$total_staked, m$total_fees, 100 * m$total_fees / max(m$total_staked, 1e-9)))
  cat(sprintf("net PnL (post-cost)  : %.2f\n", m$total_pnl))
  cat(sprintf("ROI  (post-cost)     : %+.2f%%  [%+.2f%%, %+.2f%%]\n",
              100 * m$roi, 100 * ci["roi", 1], 100 * ci["roi", 3]))
  cat(sprintf("max drawdown         : %.2f   [%.2f, %.2f]\n",
              m$max_dd, ci["max_dd", 1], ci["max_dd", 3]))

  verdict <- if (is.na(m$roi)) "NO TRADES — model never cleared costs"
             else if (ci["roi", 1] > 0)
               "ROI CI excludes zero (positive) — edge survives costs in this world"
             else if (ci["roi", 3] < 0)
               "ROI CI excludes zero (NEGATIVE) — this strategy reliably LOSES money"
             else "ROI CI includes zero — NO demonstrated edge after costs"
  cat(sprintf("VERDICT              : %s\n", verdict))

  invisible(list(metrics = m, ci = ci, trades = tr, calib = calibration_curve(tr)))
}

# ---------------------------------------------------------------------------
if (sys.nframe() == 0) {
  res <- list()
  # World A: the project's hypothesis is TRUE (market prices a flat sigma).
  res$hyp  <- run_scenario("WORLD A — market blind to regime (hypothesis TRUE)",
                           market_knows_regime = FALSE, mode = "exog")
  # World B: the NULL. Market already prices the regime.
  res$null <- run_scenario("WORLD B — market prices regime (NULL)",
                           market_knows_regime = TRUE,  mode = "exog")
  # Control: no weather feed at all.
  res$ar   <- run_scenario("WORLD A — autoregressive control (no weather feed)",
                           market_knows_regime = FALSE, mode = "ar")

  cat("\n--- calibration (World A, exog) ---\n")
  print(as.data.frame(res$hyp$calib), digits = 3)

  dir.create("data", showWarnings = FALSE)
  saveRDS(res, "data/backtest_results.rds")
  cat("\n[backtest] results -> data/backtest_results.rds\n")
  cat("\nNOTE: these are SIMULATED data. They validate the pipeline, not the edge.\n")
}
