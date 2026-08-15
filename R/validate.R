#!/usr/bin/env Rscript
# =============================================================================
# validate.R  —  OUT-OF-SAMPLE validation harness  (base R + jsonlite)
# -----------------------------------------------------------------------------
# Reads settled station-day rows and reports, honestly:
#   * reliability diagram (calibration) + Brier multi-class score, split
#     FLAGGED (detector FIRE) vs UNFLAGGED
#   * Murphy Brier decomposition: reliability - resolution + uncertainty
#   * P&L net of QUADRATIC fees for the FIRE strategy
#   * BLOCK bootstrap CI on the autocorrelated daily P&L (NOT iid)
#   * deflated Sharpe + a bootstrap SPA-style one-sided p-value (multiple-testing
#     aware)
#   * an explicit "insufficient N" verdict when there are too few settled days
#     to claim anything real.
#
# Uses detector_score() from lib_pricing.R so the FIRE rule is IDENTICAL to
# bust_detector.R. Read-only re: money. Writes only analysis artifacts under the
# declared reports/ path. Deterministic & seeded.
# =============================================================================

.here <- function() {
  # Locate lib_pricing.R whether this file is run directly (Rscript R/x.R) or
  # sourced from elsewhere. Search: --file dir, any source() ofile dirs, cwd/R, cwd.
  cand <- character(0)
  a <- commandArgs(FALSE); f <- sub("^--file=", "", a[grep("^--file=", a)])
  if (length(f)) cand <- c(cand, dirname(normalizePath(f)))
  for (i in rev(seq_len(sys.nframe()))) {
    of <- tryCatch(get("ofile", envir = sys.frame(i)), error = function(e) NULL)
    if (!is.null(of)) cand <- c(cand, dirname(normalizePath(of)))
  }
  cand <- c(cand, file.path(getwd(), "R"), getwd())
  for (d in cand) if (file.exists(file.path(d, "lib_pricing.R"))) return(d)
  if (length(cand)) cand[1] else "R"
}
source(file.path(.here(), "lib_pricing.R"))

month_of <- function(date) as.integer(format(as.Date(date), "%m"))

# ---------------------------------------------------------------------------
# Turn one settled row into an evaluation record (probs, market, outcome, P&L).
# ---------------------------------------------------------------------------
eval_row <- function(row) {
  settled <- suppressWarnings(as.integer(row$settled[1]))
  high_f  <- suppressWarnings(as.numeric(row$settle_high_f[1]))
  if (is.na(settled) || settled != 1L || !is.finite(high_f)) return(NULL)

  members <- suppressWarnings(as.numeric(strsplit(as.character(row$fc_member_max_csv[1]), ";")[[1]]))
  members <- members[is.finite(members)]
  labels  <- strsplit(as.character(row$mkt_bins_csv[1]), ";")[[1]]
  devig   <- suppressWarnings(as.numeric(strsplit(as.character(row$mkt_devig_csv[1]), ";")[[1]]))
  mids    <- suppressWarnings(as.numeric(strsplit(as.character(row$mkt_mids_csv[1]), ";")[[1]]))
  if (length(members) == 0L || length(labels) == 0L ||
      length(devig) != length(labels) || length(mids) != length(labels)) return(NULL)

  bins <- bins_from_labels(labels)
  ord  <- match(bins$bin_id, labels)
  devig <- devig[ord]; mids <- mids[ord]

  # realised bin index from the exact-degree settled high
  settle_bin <- bin_assign(round(high_f), bins)
  k <- match(settle_bin, bins$bin_id)
  if (is.na(k)) return(NULL)   # settled outside captured ladder — skip

  pm25    <- suppressWarnings(as.numeric(row$smoke_pm25[1]))
  run_max <- suppressWarnings(as.numeric(row$obs_running_max_tempF[1]))
  model   <- as.character(row$fc_model[1]); mo <- month_of(as.character(row$date[1]))

  s <- detector_score(members, model, mo, bins, devig, mids,
                      pm25 = pm25, run_max = run_max, mode = "live")

  # traded contract = best net-edge bin; win if it settles there.
  cand  <- s$best_i
  win   <- as.integer(cand == k)
  price <- mids[cand]
  pnl   <- win - price - kalshi_fee(price)   # net of quadratic fee, $/contract

  list(date = as.character(row$date[1]), flagged = (s$decision == "FIRE"),
       my_probs = s$my_probs, devig = devig, outcome_k = k, n_bins = nrow(bins),
       cand = cand, cand_f = s$my_probs[cand], cand_win = win, pnl = pnl,
       provisional = s$pd$provisional_bias)
}

# ---------------------------------------------------------------------------
# Pooled calibration: (forecast prob, outcome) over EVERY bin of EVERY row.
# ---------------------------------------------------------------------------
pool_calibration <- function(recs) {
  f <- numeric(0); y <- numeric(0)
  for (r in recs) {
    f <- c(f, r$my_probs)
    oh <- rep(0, r$n_bins); oh[r$outcome_k] <- 1
    y <- c(y, oh)
  }
  list(f = f, y = y)
}

reliability_table <- function(f, y, nbins = 10L) {
  br <- cut(f, breaks = seq(0, 1, length.out = nbins + 1L), include.lowest = TRUE)
  out <- data.frame(bucket = levels(br), n = 0L, mean_f = NA_real_, obs_freq = NA_real_)
  for (i in seq_along(levels(br))) {
    sel <- br == levels(br)[i]; nk <- sum(sel)
    out$n[i] <- nk
    if (nk > 0) { out$mean_f[i] <- mean(f[sel]); out$obs_freq[i] <- mean(y[sel]) }
  }
  out
}

print_reliability <- function(tab) {
  cat("  forecast_bucket   n     mean_fcst   obs_freq   |diagram (fcst=*, obs=o)\n")
  for (i in seq_len(nrow(tab))) {
    if (tab$n[i] == 0L) next
    scale <- function(v) max(1L, round(v * 40))
    bar <- rep(" ", 40)
    if (is.finite(tab$mean_f[i]))  bar[scale(tab$mean_f[i])]  <- "*"
    if (is.finite(tab$obs_freq[i])) bar[scale(tab$obs_freq[i])] <- "o"
    cat(sprintf("  %-15s %4d    %7.3f    %7.3f   |%s\n",
                tab$bucket[i], tab$n[i], tab$mean_f[i], tab$obs_freq[i],
                paste(bar, collapse = "")))
  }
  cat("   (perfect calibration: * and o coincide in every row)\n")
}

# Best-effort PNG reliability diagram (grDevices is base R). Never fatal.
write_reliability_png <- function(tab, path) {
  tryCatch({
    ensure_dir(path)
    grDevices::png(path, width = 640, height = 640)
    on.exit(grDevices::dev.off(), add = TRUE)
    ok <- is.finite(tab$mean_f) & is.finite(tab$obs_freq)
    plot(tab$mean_f[ok], tab$obs_freq[ok], xlim = c(0,1), ylim = c(0,1),
         xlab = "forecast probability", ylab = "observed frequency",
         main = "Reliability diagram (OOS)", pch = 19)
    abline(0, 1, lty = 2)
    TRUE
  }, error = function(e) FALSE)
}

# ---------------------------------------------------------------------------
# Full report
# ---------------------------------------------------------------------------
validate <- function(rows, write_artifacts = TRUE) {
  set_seed()
  recs <- Filter(Negate(is.null), lapply(seq_len(nrow(rows)), function(i) eval_row(rows[i, , drop = FALSE])))
  N <- length(recs)
  lines <- character(0)
  emit <- function(...) { s <- sprintf(...); lines[[length(lines) + 1]] <<- s; cat(s, "\n") }

  emit("================ validate.R  OOS report ================")
  emit("settled rows evaluated: N = %d  (min for a real verdict: %d)", N, MIN_N_VALIDATE)
  if (N == 0L) { emit("no settled rows — nothing to validate."); return(invisible(list(N = 0L))) }

  provisional_any <- any(vapply(recs, function(r) isTRUE(r$provisional), logical(1)))
  if (provisional_any)
    emit("! WARNING: some rows use a PROVISIONAL (zero) live-model bias table — any")
  if (provisional_any)
    emit("!          edge/Sharpe below is NOT trustworthy until that bias is fit OOS.")

  flagged <- vapply(recs, function(r) isTRUE(r$flagged), logical(1))
  emit("flagged (FIRE) rows: %d   unflagged: %d", sum(flagged), sum(!flagged))

  # ---- calibration + Brier (all, flagged, unflagged) ----
  cal <- pool_calibration(recs)
  emit("\n-- Reliability diagram (pooled over all bins, ALL rows) --")
  tab <- reliability_table(cal$f, cal$y)
  print_reliability(tab)

  brier_of <- function(idx) {
    if (!length(idx)) return(NA_real_)
    pm <- do.call(rbind, lapply(recs[idx], function(r) r$my_probs))
    oc <- vapply(recs[idx], function(r) r$outcome_k, integer(1))
    # all rows share the ladder width in synthetic data; guard otherwise
    if (length(unique(vapply(recs[idx], function(r) r$n_bins, integer(1)))) != 1L) return(NA_real_)
    brier_multiclass(pm, oc)
  }
  emit("\n-- Multi-class Brier (lower better) --")
  emit("  ALL      : %.4f", brier_of(seq_len(N)))
  emit("  FLAGGED  : %s", ifelse(any(flagged), sprintf("%.4f", brier_of(which(flagged))), "n/a"))
  emit("  UNFLAGGED: %s", ifelse(any(!flagged), sprintf("%.4f", brier_of(which(!flagged))), "n/a"))

  # ---- Murphy decomposition on the traded contract's binary event ----
  f_tr <- vapply(recs, function(r) r$cand_f, numeric(1))
  y_tr <- vapply(recs, function(r) r$cand_win, integer(1))
  dc_all <- brier_decomp(f_tr, y_tr)
  emit("\n-- Brier decomposition (traded contract, binary): brier = reliability - resolution + uncertainty --")
  emit("  ALL      : brier=%.4f  reliability=%.4f  resolution=%.4f  uncertainty=%.4f  (gap=%.1e, n=%d)",
       dc_all$brier, dc_all$reliability, dc_all$resolution, dc_all$uncertainty, dc_all$identity_gap, dc_all$n)
  if (any(flagged)) { d <- brier_decomp(f_tr[flagged], y_tr[flagged])
    emit("  FLAGGED  : brier=%.4f  reliability=%.4f  resolution=%.4f  uncertainty=%.4f  (n=%d)",
         d$brier, d$reliability, d$resolution, d$uncertainty, d$n) }
  if (any(!flagged)) { d <- brier_decomp(f_tr[!flagged], y_tr[!flagged])
    emit("  UNFLAGGED: brier=%.4f  reliability=%.4f  resolution=%.4f  uncertainty=%.4f  (n=%d)",
         d$brier, d$reliability, d$resolution, d$uncertainty, d$n) }

  # ---- P&L of the FIRE strategy (net of quadratic fees) ----
  dates <- vapply(recs, function(r) r$date, character(1))
  o <- order(dates); recs_o <- recs[o]; flagged_o <- flagged[o]
  pnl_fire <- vapply(recs_o[flagged_o], function(r) r$pnl, numeric(1))
  emit("\n-- P&L (FIRE strategy, $/contract, net of quadratic fees) --")
  if (length(pnl_fire) == 0L) {
    emit("  no FIRE signals in-sample — no strategy P&L to evaluate.")
  } else {
    emit("  trades=%d  total=%.3f  mean/trade=%.4f  hit_rate=%.3f",
         length(pnl_fire), sum(pnl_fire), mean(pnl_fire),
         mean(vapply(recs_o[flagged_o], function(r) r$cand_win, integer(1))))
    bb <- block_bootstrap_mean(pnl_fire)
    emit("  block-bootstrap mean/trade 95%% CI: [%.4f, %.4f]  (block_len=%d, boot=%d) [NOT iid]",
         bb$lo, bb$hi, bb$block_len, bb$n_boot)
    # SPA-style one-sided p-value: P(bootstrap mean <= 0) under block resampling
    p_spa <- spa_pvalue(pnl_fire)
    ds <- deflated_sharpe(pnl_fire, n_trials = max(1L, length(recs)))  # trials ~ candidate bins tested
    emit("  per-trade Sharpe=%s  deflated-SR prob(SR>0)=%s  SPA p(mean<=0)=%.3f",
         ifelse(is.finite(ds$sharpe), sprintf("%.3f", ds$sharpe), "n/a"),
         ifelse(is.finite(ds$dsr), sprintf("%.3f", ds$dsr), "n/a"), p_spa)
  }

  # ---- honest verdict ----
  emit("\n-- VERDICT --")
  n_eff <- if (length(pnl_fire)) length(pnl_fire) else N
  if (N < MIN_N_VALIDATE || (length(pnl_fire) && length(pnl_fire) < MIN_N_VALIDATE)) {
    emit("  INSUFFICIENT N: %d effective observations < %d required.", n_eff, MIN_N_VALIDATE)
    emit("  Report is descriptive only. Do NOT treat any edge/Sharpe above as established.")
  } else {
    bb <- block_bootstrap_mean(pnl_fire); ds <- deflated_sharpe(pnl_fire, n_trials = N)
    verdict <- if (bb$lo > 0 && ds$dsr > 0.95) "edge SURVIVES block-bootstrap + deflation"
               else "edge NOT established after block-bootstrap + multiple-testing correction"
    emit("  %s (CI_lo=%.4f, dSR=%.3f).", verdict, bb$lo, ds$dsr)
  }
  if (provisional_any)
    emit("  (Reminder: provisional live-model bias in play — verdict is not tradable.)")

  if (write_artifacts) {
    p <- paths()
    png_ok <- write_reliability_png(tab, p$reliability_png)
    ensure_dir(p$validate_report)
    writeLines(lines, p$validate_report)
    cat(sprintf("\n[artifacts] report -> %s ; reliability png -> %s\n",
                p$validate_report, if (png_ok) p$reliability_png else "(png skipped)"))
  }
  invisible(list(N = N, n_fire = length(pnl_fire), recs = recs))
}

# SPA-flavoured one-sided bootstrap p-value for H0: mean(pnl) <= 0, using the
# SAME block resampling so autocorrelation is respected.
spa_pvalue <- function(x, block_len = BLOCK_LEN_DAYS, n_boot = N_BOOT) {
  x <- x[is.finite(x)]; n <- length(x); if (n < 2L) return(NA_real_)
  bl <- max(1L, min(block_len, n)); nblk <- ceiling(n / bl); smax <- n - bl + 1L
  mu <- mean(x); cnt <- 0L
  for (b in seq_len(n_boot)) {
    idx <- integer(0)
    for (k in seq_len(nblk)) { s <- sample.int(smax, 1L); idx <- c(idx, s:(s + bl - 1L)) }
    idx <- idx[seq_len(n)]
    # centre resample under H0 (subtract observed mean) -> null distribution of mean
    if (mean(x[idx]) - mu >= mu) cnt <- cnt + 1L
  }
  cnt / n_boot
}

# =============================================================================
# SELFTEST — synthetic OOS history; shows both the insufficient-N path and,
# on a larger sample, the full verdict path. Offline, temp dir only.
# =============================================================================
make_synth_history <- function(ndays, seed = 1L, fire_frac = 0.25) {
  set.seed(seed)
  labels <- c("<=83","84-85","86-87","88-89","90-91","92-93",">=94")
  bins <- bins_from_labels(labels)
  start <- as.Date("2026-06-01")
  rows <- vector("list", ndays)
  for (i in seq_len(ndays)) {
    date <- as.character(start + (i - 1))
    true_high <- round(89 + 3 * sin(i / 6) + rnorm(1, 0, 2))         # autocorrelated-ish
    # archive model runs cold: members ~ true - Aug bias(2.5) + noise
    members <- round((true_high - 2.5) + rnorm(20, 0, 1.6), 1)
    # market: noisy Gaussian around true, sometimes biased high (exploitable)
    mkt_mu <- true_high + rnorm(1, 0, 1.0)
    mkt_sd <- 2.4
    mp <- bin_probabilities(mkt_mu, mkt_sd, bins)
    # inject a smoke-driven bust on ~fire_frac of days: true high drops, market slow
    smoke <- NA_real_; run_max <- NA_real_
    if (runif(1) < fire_frac) {
      true_high <- true_high - round(runif(1, 3, 6))                  # smoke suppresses high
      smoke <- round(runif(1, 80, 160), 1)
      members <- round((true_high - 2.5) + rnorm(20, 0, 1.6), 1)      # model sees cooler
      # market lags (still priced on the hot forecast) -> mp unchanged (stale)
      run_max <- true_high - round(runif(1, 0, 2))
    }
    devig <- mp / sum(mp)
    mids  <- devig * (1 + OVERROUND_EXPECTED)                          # add vig back
    settle_bin <- bin_assign(true_high, bins)
    rows[[i]] <- data.frame(
      station = "chi_midway", date = date, fc_model = "archive",
      fc_member_max_csv = paste(members, collapse = ";"),
      mkt_bins_csv = paste(labels, collapse = ";"),
      mkt_devig_csv = paste(round(devig, 4), collapse = ";"),
      mkt_mids_csv = paste(round(mids, 4), collapse = ";"),
      smoke_pm25 = smoke, obs_running_max_tempF = run_max,
      settled = 1L, settle_high_f = true_high, settle_bin = settle_bin,
      stringsAsFactors = FALSE)
  }
  do.call(rbind, rows)
}

selftest <- function() {
  set_seed(); lib_selfcheck()
  td <- tempfile("validate_selftest_"); dir.create(td); Sys.setenv(KALSHI_DATA_DIR = td)

  cat("\n########## SMALL sample (N=30): must report INSUFFICIENT N ##########\n")
  small <- make_synth_history(30, seed = 7)
  r1 <- validate(small, write_artifacts = FALSE)
  stopifnot(r1$N == 30)

  cat("\n########## LARGE sample (N=600): full verdict path (>=100 trades) ##########\n")
  large <- make_synth_history(600, seed = 42, fire_frac = 0.30)
  r2 <- validate(large, write_artifacts = TRUE)
  stopifnot(r2$N == 600, r2$n_fire >= MIN_N_VALIDATE)   # exercises SURVIVES/NOT branch
  stopifnot(file.exists(paths()$validate_report))
  cat("\n[selftest] PASS\n")
  invisible(TRUE)
}

main <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  if ("--selftest" %in% args) { selftest(); return(invisible()) }
  set_seed(); lib_selfcheck()
  d <- read_csv_safe(paths()$daily)
  if (is.null(d)) { cat("no daily.csv found — run collector.R first\n"); return(invisible()) }
  d <- d[suppressWarnings(as.integer(d$settled)) == 1L & !is.na(d$settled), , drop = FALSE]
  validate(d)
  invisible()
}

if (.invoked_directly("validate.R")) main()
