#!/usr/bin/env Rscript
# =============================================================================
# hmm.R — Hidden Markov / regime-switching layer
#
# HYPOTHESIS (market_selection.md §4): forecast-error VARIANCE is regime
# dependent — quiescent synoptic days are easy, disturbed days are hard — while
# the market prices a roughly flat sigma. If true, a regime-aware predictive
# distribution is better calibrated in the tails and that is a tradeable
# calibration edge.
#
# STRUCTURE
#   1. Fit NGR (model.R) -> conditional mean mu_t. This removes the signal.
#   2. Fit a K-state Gaussian HMM to the NGR RESIDUALS by Baum-Welch.
#      The latent state is therefore a FORECAST-DIFFICULTY regime, not a
#      hot/cold regime. That distinction is the whole point.
#   3. Predictive distribution = MIXTURE of state-conditional Normals, weighted
#      by the one-step-ahead predicted state distribution.
#   4. Integrate the mixture over bracket edges -> final probability.
#
# Baum-Welch is implemented here directly: depmixS4 / hmmTMB are unavailable
# because CRAN is egress-blocked in this environment. Hand-rolling it also makes
# the state semantics auditable, which matters more than convenience here.
# =============================================================================

suppressPackageStartupMessages({ library(dplyr); library(tibble) })
source("kalshi_data.R")
source("model.R")
source("backtest.R")

# ---------------------------------------------------------------------------
# Gaussian HMM by Baum-Welch (scaled forward-backward)
# ---------------------------------------------------------------------------

hmm_emission <- function(x, mu, sigma) {
  # n x K matrix of state-conditional densities
  outer(x, seq_along(mu), function(v, k) dnorm(v, mu[k], sigma[k]))
}

hmm_forward <- function(B, pi0, A) {
  n <- nrow(B); K <- ncol(B)
  alpha <- matrix(0, n, K); scale <- numeric(n)
  a <- pi0 * B[1, ]; scale[1] <- sum(a); alpha[1, ] <- a / max(scale[1], 1e-300)
  for (t in 2:n) {
    a <- (alpha[t - 1, ] %*% A) * B[t, ]
    scale[t] <- sum(a)
    alpha[t, ] <- a / max(scale[t], 1e-300)
  }
  list(alpha = alpha, scale = scale, loglik = sum(log(pmax(scale, 1e-300))))
}

hmm_backward <- function(B, A, scale) {
  n <- nrow(B); K <- ncol(B)
  beta <- matrix(0, n, K); beta[n, ] <- 1
  for (t in (n - 1):1) {
    b <- A %*% (B[t + 1, ] * beta[t + 1, ])
    beta[t, ] <- as.numeric(b) / max(scale[t + 1], 1e-300)
  }
  beta
}

fit_hmm <- function(x, K = 2, iter = 200, tol = 1e-6, seed = 11) {
  set.seed(seed)
  x <- as.numeric(x); x <- x[is.finite(x)]
  n <- length(x)
  if (n < 50) stop("fit_hmm: need >=50 observations, got ", n)

  # Init: split by |residual| so states start separated on VARIANCE, which is
  # the dimension we actually care about. A k-means-on-level init would tend to
  # find hot/cold instead and then get stuck there.
  q     <- quantile(abs(x), seq(0, 1, length.out = K + 1))
  grp   <- cut(abs(x), unique(q), include.lowest = TRUE, labels = FALSE)
  mu    <- tapply(x, grp, mean);  sigma <- tapply(x, grp, sd)
  mu    <- as.numeric(mu); sigma <- pmax(as.numeric(sigma), 0.3)
  A     <- matrix(0.15 / (K - 1), K, K); diag(A) <- 0.85
  pi0   <- rep(1 / K, K)

  ll_old <- -Inf
  for (it in seq_len(iter)) {
    B  <- hmm_emission(x, mu, sigma)
    B[B < 1e-300] <- 1e-300
    fw <- hmm_forward(B, pi0, A)
    bw <- hmm_backward(B, A, fw$scale)

    gamma <- fw$alpha * bw
    gamma <- gamma / pmax(rowSums(gamma), 1e-300)

    # xi: expected transition counts
    xi <- matrix(0, K, K)
    for (t in 1:(n - 1)) {
      num <- (fw$alpha[t, ] %o% (B[t + 1, ] * bw[t + 1, ])) * A
      xi  <- xi + num / max(sum(num), 1e-300)
    }

    pi0   <- gamma[1, ] / sum(gamma[1, ])
    A     <- xi / pmax(rowSums(xi), 1e-300)
    w     <- colSums(gamma)
    mu    <- colSums(gamma * x) / pmax(w, 1e-300)
    sigma <- sqrt(colSums(gamma * outer(x, mu, "-")^2) / pmax(w, 1e-300))
    sigma <- pmax(sigma, 0.15)                 # variance floor: keeps EM stable

    if (abs(fw$loglik - ll_old) < tol) break
    ll_old <- fw$loglik
  }

  ord <- order(sigma)                          # state 1 = calm, state K = disturbed
  structure(list(pi0 = pi0[ord], A = A[ord, ord, drop = FALSE],
                 mu = mu[ord], sigma = sigma[ord], K = K,
                 loglik = ll_old, n = n, iters = it),
            class = "hmm_fit")
}

# One-step-ahead predicted state distribution given residual history
hmm_predict_state <- function(fit, x_hist) {
  x_hist <- as.numeric(x_hist); x_hist <- x_hist[is.finite(x_hist)]
  if (!length(x_hist)) return(fit$pi0)
  B <- hmm_emission(x_hist, fit$mu, fit$sigma); B[B < 1e-300] <- 1e-300
  fw <- hmm_forward(B, fit$pi0, fit$A)
  filt <- fw$alpha[nrow(fw$alpha), ]
  as.numeric(filt %*% fit$A)                   # propagate one step forward
}

# Mixture-of-normals bucket probability
mixture_bucket_prob <- function(mu_base, weights, mu_k, sigma_k, lower, upper) {
  p <- 0
  for (k in seq_along(weights)) {
    p <- p + weights[k] * (pnorm(upper, mu_base + mu_k[k], sigma_k[k]) -
                           pnorm(lower, mu_base + mu_k[k], sigma_k[k]))
  }
  pmin(pmax(p, 1e-6), 1 - 1e-6)
}

# ---------------------------------------------------------------------------
# Walk-forward with the HMM layer on top of NGR
# ---------------------------------------------------------------------------

walkforward_hmm <- function(d, K = 2) {
  dd    <- daily_frame(d)
  start <- max(floor(nrow(dd) * BT$train_frac), 90)
  ngr <- NULL; hmm <- NULL; out <- list()

  for (i in seq(start + 1, nrow(dd))) {
    hist <- dd[1:(i - 1), ]
    if (is.null(ngr) || (i - start - 1) %% BT$refit_every == 0) {
      ngr <- tryCatch(fit_ngr(hist), error = function(e) NULL)
      if (!is.null(ngr)) {
        resid_hist <- hist$realized - predict_ngr(ngr, hist)$mu
        hmm <- tryCatch(fit_hmm(resid_hist, K = K), error = function(e) NULL)
      }
    }
    if (is.null(ngr) || is.null(hmm)) next

    resid_hist <- hist$realized - predict_ngr(ngr, hist)$mu
    w   <- hmm_predict_state(hmm, resid_hist)
    pr  <- predict_ngr(ngr, dd[i, , drop = FALSE])

    # Mixture sd: E[Var] + Var[E]. Computed here, before the tibble, because
    # inside tibble() `w` would resolve to the list-column defined on the line above.
    eff_sd <- sqrt(sum(w * (hmm$sigma^2 + hmm$mu^2)) - sum(w * hmm$mu)^2)

    out[[length(out) + 1]] <- tibble(
      date = dd$date[i], mu = pr$mu, sigma = pr$sigma,
      w = list(w), mu_k = list(hmm$mu), sigma_k = list(hmm$sigma),
      eff_sigma = eff_sd
    )
  }
  pred <- bind_rows(out)

  d |>
    inner_join(pred, by = "date") |>
    rowwise() |>
    mutate(
      model_prob = mixture_bucket_prob(mu, w, mu_k, sigma_k, lower, upper),
      flat_prob  = bucket_prob(mu, sigma, lower, upper)
    ) |>
    ungroup()
}

# ---------------------------------------------------------------------------
# Head-to-head: HMM mixture vs flat NGR
# ---------------------------------------------------------------------------

compare_hmm <- function(label, market_knows_regime, K = 2, n_days = 900,
                        ens_informative = TRUE) {
  d  <- simulate_market_days(n_days = n_days, market_knows_regime = market_knows_regime,
                             ens_informative = ens_informative)
  wf <- walkforward_hmm(d, K = K)

  b_hmm  <- mean((wf$model_prob   - wf$outcome)^2)
  b_flat <- mean((wf$flat_prob    - wf$outcome)^2)
  b_mkt  <- mean((wf$implied_prob - wf$outcome)^2)

  tr_hmm  <- apply_trades(wf)
  tr_flat <- apply_trades(wf |> mutate(model_prob = flat_prob))
  m_hmm   <- metrics(tr_hmm); m_flat <- metrics(tr_flat)
  ci_hmm  <- mc_ci(tr_hmm);   ci_flat <- mc_ci(tr_flat)

  cat(sprintf("\n================ %s ================\n", label))
  cat(sprintf("states K=%d, %d market-days scored\n", K, length(unique(wf$date))))
  cat("\n                      Brier        ROI (post-cost)      trades\n")
  cat(sprintf("HMM mixture       %.5f     %+6.2f%% [%+.2f,%+.2f]   %d\n",
              b_hmm,  100 * m_hmm$roi,  100 * ci_hmm["roi", 1],  100 * ci_hmm["roi", 3],  m_hmm$n_trades))
  cat(sprintf("flat NGR          %.5f     %+6.2f%% [%+.2f,%+.2f]   %d\n",
              b_flat, 100 * m_flat$roi, 100 * ci_flat["roi", 1], 100 * ci_flat["roi", 3], m_flat$n_trades))
  cat(sprintf("market            %.5f\n", b_mkt))
  cat(sprintf("\nHMM vs flat Brier : %+.2f%% (positive = HMM better)\n",
              100 * (1 - b_hmm / b_flat)))
  cat(sprintf("HMM vs market     : %+.2f%%\n", 100 * (1 - b_hmm / b_mkt)))

  # Paired bootstrap on the Brier DIFFERENCE — the only honest way to call a
  # head-to-head, since both models see identical days.
  set.seed(3); days <- unique(wf$date); B <- 600
  diffs <- vapply(seq_len(B), function(b) {
    s   <- sample(days, length(days), replace = TRUE)
    idx <- unlist(lapply(s, function(dt) which(wf$date == dt)), use.names = FALSE)
    x   <- wf[idx, ]
    mean((x$flat_prob - x$outcome)^2) - mean((x$model_prob - x$outcome)^2)
  }, numeric(1))
  q <- quantile(diffs, c(0.025, 0.975))
  cat(sprintf("paired Brier diff (flat - HMM): %.6f  95%% CI [%.6f, %.6f]\n",
              mean(diffs), q[1], q[2]))
  cat(sprintf("VERDICT: %s\n",
      if (q[1] > 0) "HMM layer IMPROVES calibration (CI excludes zero)"
      else if (q[2] < 0) "HMM layer DEGRADES calibration (CI excludes zero)"
      else "HMM layer shows NO significant calibration gain"))

  invisible(list(b_hmm = b_hmm, b_flat = b_flat, b_mkt = b_mkt,
                 m_hmm = m_hmm, m_flat = m_flat, diff_ci = q, wf = wf))
}

# ---------------------------------------------------------------------------
if (sys.nframe() == 0) {
  r <- list()
  r$hyp  <- compare_hmm("WORLD A — market blind to regime (hypothesis TRUE)",  FALSE)
  r$null <- compare_hmm("WORLD B — market prices regime (NULL)",               TRUE)
  # World C isolates the HMM's actual job: no contemporaneous dispersion signal,
  # so the regime can only be inferred from residual history.
  r$noens <- compare_hmm("WORLD C — ensemble spread UNINFORMATIVE (HMM's real test)",
                         FALSE, ens_informative = FALSE)

  # What did the HMM actually learn?
  d0 <- simulate_market_days(n_days = 900)
  dd <- daily_frame(d0)
  ng <- fit_ngr(dd)
  hm <- fit_hmm(dd$realized - predict_ngr(ng, dd)$mu, K = 2)
  cat("\n--- fitted 2-state HMM on NGR residuals (full sample) ---\n")
  cat(sprintf("state 1 (calm)     : mu %+.3f  sigma %.3f\n", hm$mu[1], hm$sigma[1]))
  cat(sprintf("state 2 (disturbed): mu %+.3f  sigma %.3f\n", hm$mu[2], hm$sigma[2]))
  cat("transition matrix:\n"); print(round(hm$A, 3))
  cat(sprintf("persistence: P(stay|calm)=%.3f  P(stay|disturbed)=%.3f\n",
              hm$A[1, 1], hm$A[2, 2]))

  saveRDS(r, "data/hmm_results.rds")
  cat("\n[hmm] results -> data/hmm_results.rds\n")
  cat("\nNOTE: SIMULATED data. Validates the pipeline, not the edge.\n")
}
