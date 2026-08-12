#!/usr/bin/env Rscript
# =============================================================================
# model.R — predictive distribution -> calibrated bucket probability
#
# Two switchable predictor modes, per the brief:
#
#   mode "exog" : Nonhomogeneous Gaussian Regression (NGR / EMOS).
#                 mu    = a + b * forecast + g * climatology
#                 sigma = sqrt(c^2 + d^2 * ens_sd^2)
#                 Fitted by minimising CRPS — the standard estimator in the
#                 ensemble-postprocessing literature (research_summary.md §2.2).
#                 The `d` term is what corrects raw-ensemble underdispersion; if
#                 the fitted d is ~0 the ensemble spread carries no information.
#
#   mode "ar"   : Seasonal decomposition + AR(p) on the anomaly. No weather feed.
#                 Exists as an honest control: it measures what the series' own
#                 history is worth alone. It is EXPECTED to lose to "exog".
#
# Both modes emit a predictive N(mu, sigma), which is integrated over the bracket
# edges to give P(lower < T <= upper) — directly comparable to the market's
# implied price.
# =============================================================================

suppressPackageStartupMessages({ library(dplyr); library(tibble) })

# ---------------------------------------------------------------------------
# Bucket probability: integrate the predictive density over the bracket
# ---------------------------------------------------------------------------

bucket_prob <- function(mu, sigma, lower, upper) {
  sigma <- pmax(sigma, 1e-6)
  p <- pnorm(upper, mu, sigma) - pnorm(lower, mu, sigma)
  pmin(pmax(p, 1e-6), 1 - 1e-6)
}

# ---------------------------------------------------------------------------
# CRPS for a Gaussian predictive distribution (closed form)
# ---------------------------------------------------------------------------

crps_norm <- function(y, mu, sigma) {
  sigma <- pmax(sigma, 1e-6)
  z <- (y - mu) / sigma
  sigma * (z * (2 * pnorm(z) - 1) + 2 * dnorm(z) - 1 / sqrt(pi))
}

# ---------------------------------------------------------------------------
# Collapse the per-bucket frame to one row per market-day
# ---------------------------------------------------------------------------

daily_frame <- function(d) {
  d |>
    group_by(date) |>
    summarise(
      realized = first(realized_value),
      forecast = if ("forecast" %in% names(d)) first(forecast) else NA_real_,
      ens_sd   = if ("ens_sd"   %in% names(d)) first(ens_sd)   else NA_real_,
      clim     = if ("clim"     %in% names(d)) first(clim)     else NA_real_,
      .groups  = "drop"
    ) |>
    arrange(date)
}

# ---------------------------------------------------------------------------
# Mode (a): NGR / EMOS
# ---------------------------------------------------------------------------

fit_ngr <- function(train) {
  tr <- train |> filter(is.finite(realized), is.finite(forecast), is.finite(ens_sd))
  if (nrow(tr) < 30) stop("fit_ngr: need >=30 training days, got ", nrow(tr))

  has_clim <- any(is.finite(tr$clim))
  obj <- function(par) {
    mu <- par[1] + par[2] * tr$forecast + if (has_clim) par[5] * (tr$clim - mean(tr$clim)) else 0
    sg <- sqrt(par[3]^2 + par[4]^2 * tr$ens_sd^2)
    mean(crps_norm(tr$realized, mu, sg))
  }
  start <- c(0, 1, 1, 0.5, 0)
  fit <- optim(start, obj, method = "BFGS", control = list(maxit = 500))
  structure(list(par = fit$par, has_clim = has_clim,
                 clim_mean = if (has_clim) mean(tr$clim) else 0,
                 crps = fit$value, n = nrow(tr)),
            class = "ngr_fit")
}

predict_ngr <- function(fit, newdata) {
  p <- fit$par
  mu <- p[1] + p[2] * newdata$forecast +
        if (fit$has_clim) p[5] * (newdata$clim - fit$clim_mean) else 0
  sg <- sqrt(p[3]^2 + p[4]^2 * newdata$ens_sd^2)
  tibble(date = newdata$date, mu = mu, sigma = pmax(sg, 1e-6))
}

# ---------------------------------------------------------------------------
# Mode (b): seasonal + AR(p) on the anomaly
# ---------------------------------------------------------------------------

fit_ar <- function(train, p = 2) {
  tr <- train |> filter(is.finite(realized)) |> arrange(date)
  if (nrow(tr) < 60) stop("fit_ar: need >=60 training days, got ", nrow(tr))

  doy <- as.integer(format(tr$date, "%j"))
  # Fit the seasonal cycle rather than assuming the fixture's climatology, so
  # this mode works on live data where `clim` may be absent.
  seas <- lm(realized ~ sin(2*pi*doy/365) + cos(2*pi*doy/365) +
                        sin(4*pi*doy/365) + cos(4*pi*doy/365), data = tr)
  anom <- residuals(seas)

  lagm <- embed(anom, p + 1)
  df   <- as.data.frame(lagm)
  names(df) <- c("y", paste0("l", seq_len(p)))
  armod <- lm(y ~ ., data = df)

  structure(list(seas = seas, ar = armod, p = p,
                 sigma = sd(residuals(armod)),
                 last_anom = tail(anom, p)),
            class = "ar_fit")
}

predict_ar <- function(fit, newdata) {
  doy  <- as.integer(format(newdata$date, "%j"))
  base <- predict(fit$seas, newdata = data.frame(doy = doy))
  # One-step-ahead: the most recent p anomalies are the regressors.
  nd <- as.data.frame(t(rev(fit$last_anom)))
  names(nd) <- paste0("l", seq_len(fit$p))
  anom_hat <- as.numeric(predict(fit$ar, newdata = nd))
  tibble(date = newdata$date,
         mu = base + anom_hat,
         sigma = rep(fit$sigma, nrow(newdata)))
}

# Update AR state as we walk forward (keeps the model causal)
ar_push <- function(fit, realized, date) {
  doy  <- as.integer(format(date, "%j"))
  base <- predict(fit$seas, newdata = data.frame(doy = doy))
  fit$last_anom <- c(fit$last_anom[-1], realized - base)
  fit
}

# ---------------------------------------------------------------------------
# Unified interface
# ---------------------------------------------------------------------------

fit_model <- function(train_daily, mode = c("exog", "ar"), ...) {
  mode <- match.arg(mode)
  switch(mode, exog = fit_ngr(train_daily, ...), ar = fit_ar(train_daily, ...))
}

predict_model <- function(fit, newdata_daily) {
  if (inherits(fit, "ngr_fit")) predict_ngr(fit, newdata_daily) else predict_ar(fit, newdata_daily)
}

# Attach model probabilities to the per-bucket frame
attach_probs <- function(buckets, pred) {
  buckets |>
    left_join(pred, by = "date") |>
    mutate(model_prob = bucket_prob(mu, sigma, lower, upper))
}

# ---------------------------------------------------------------------------
if (sys.nframe() == 0) {
  source("kalshi_data.R")
  d <- if (file.exists("data/market_days.csv")) {
    x <- read.csv("data/market_days.csv", stringsAsFactors = FALSE)
    x$date <- as.Date(x$date); x
  } else load_market_days()

  dd <- daily_frame(d)
  cut <- floor(nrow(dd) * 0.6)
  train <- dd[1:cut, ]; test <- dd[(cut + 1):nrow(dd), ]

  for (m in c("exog", "ar")) {
    fit  <- fit_model(train, m)
    pred <- predict_model(fit, test)
    cat(sprintf("\n--- mode '%s' ---\n", m))
    if (m == "exog") {
      p <- fit$par
      cat(sprintf("  mu    = %.3f + %.3f*forecast + %.3f*clim_c\n", p[1], p[2], p[5]))
      cat(sprintf("  sigma = sqrt(%.3f^2 + %.3f^2 * ens_sd^2)   [d~0 => spread uninformative]\n",
                  p[3], p[4]))
    }
    cat(sprintf("  test CRPS      : %.4f\n", mean(crps_norm(test$realized, pred$mu, pred$sigma))))
    cat(sprintf("  test RMSE (mu) : %.4f\n", sqrt(mean((test$realized - pred$mu)^2))))
    cat(sprintf("  mean sigma     : %.3f\n", mean(pred$sigma)))
  }
}
