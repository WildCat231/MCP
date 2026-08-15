#!/usr/bin/env Rscript
# =============================================================================
# bust_detector.R  —  READ-ONLY scorer  (base R + jsonlite)
# -----------------------------------------------------------------------------
# Reads a collected station-day row and produces, WITHOUT writing anything and
# WITHOUT touching money:
#   * a bias-corrected, appropriately-WIDENED bin distribution (per-month AND
#     per-model bias; SD floored at the residual and capped for non-concentration)
#   * the de-vigged market distribution
#   * divergence (Jensen-Shannon distance) mine vs market
#   * an OBSERVABLE-anomaly flag:
#       - smoke onset present in inputs (elevated PM2.5) but not in forecast/price
#       - intraday obs already PAST a bin edge the market still prices as uncertain
#   * FIRE / NO-FIRE — fires ONLY when divergence is large AND an anomaly is
#     observable AND the best net edge clears vig + quadratic fees. The net-edge
#     arithmetic is printed in full.
#
# All gates are documented PLACEHOLDER constants in lib_pricing.R, NOT fitted.
# This script never writes a file, never holds a credential, never orders.
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
# Core scorer. `row` is a one-row data.frame in daily.csv schema (character).
# Returns a structured verdict list; prints a human-readable report.
# ---------------------------------------------------------------------------
score_row <- function(row, verbose = TRUE) {
  station <- as.character(row$station[1]); date <- as.character(row$date[1])
  model <- as.character(row$fc_model[1]); mo <- month_of(date)

  members <- suppressWarnings(as.numeric(strsplit(as.character(row$fc_member_max_csv[1]), ";")[[1]]))
  members <- members[is.finite(members)]
  bin_labels <- strsplit(as.character(row$mkt_bins_csv[1]), ";")[[1]]
  mkt_devig  <- suppressWarnings(as.numeric(strsplit(as.character(row$mkt_devig_csv[1]), ";")[[1]]))
  mkt_mids   <- suppressWarnings(as.numeric(strsplit(as.character(row$mkt_mids_csv[1]), ";")[[1]]))

  if (length(members) == 0L || length(bin_labels) == 0L ||
      length(mkt_devig) != length(bin_labels)) {
    if (verbose) cat(sprintf("[%s %s] insufficient inputs (members=%d bins=%d) -> NO-FIRE (no data)\n",
                             station, date, length(members), length(bin_labels)))
    return(list(decision = "NO-FIRE", reason = "insufficient_inputs"))
  }

  bins <- bins_from_labels(bin_labels)
  # align market vectors to the sorted bin order
  ord <- match(bins$bin_id, bin_labels)
  mkt_devig <- mkt_devig[ord]; mkt_mids <- mkt_mids[ord]

  pm25 <- suppressWarnings(as.numeric(row$smoke_pm25[1]))
  run_max <- suppressWarnings(as.numeric(row$obs_running_max_tempF[1]))

  # single-source firing rule (identical to validate.R)
  s <- detector_score(members, model, mo, bins, mkt_devig, mkt_mids,
                      pm25 = pm25, run_max = run_max, mode = "live")
  pd <- s$pd; my_probs <- s$my_probs
  jsd <- s$jsd; tvd <- s$tvd
  anom_smoke <- s$anom_smoke; anom_obs <- s$anom_obs; anom_obs_bins <- s$stale_bins
  anomaly <- s$anomaly
  net <- s$net; best_i <- s$best_i; best_net <- s$best_net; best_fee <- s$best_fee
  gate_div <- s$gate_div; gate_anom <- s$gate_anom; gate_edge <- s$gate_edge
  decision <- s$decision

  if (verbose) {
    cat(sprintf("\n===== bust_detector: %s %s (model=%s, month=%02d) =====\n",
                station, date, model, mo))
    if (pd$provisional_bias)
      cat("  ! bias for this model is PROVISIONAL (zeros) — treat edge as unproven\n")
    cat(sprintf("  predictive: mu=%.2fF  member_sd=%.2f  widened_sd=%.2f  sd_used=%.2f  max_bin=%.2f%s\n",
                pd$mu, pd$member_sd, pd$widened_sd, pd$sd_used, max(my_probs),
                if (pd$capped) " (non-concentration cap applied)" else ""))
    cat("  bin        mine   market   net_edge($)\n")
    for (i in seq_len(nrow(bins)))
      cat(sprintf("  %-9s %6.3f  %6.3f   %+.4f%s\n", bins$bin_id[i], my_probs[i],
                  mkt_devig[i], net[i], if (i == best_i) "  <= best" else ""))
    cat(sprintf("  sum(mine)=%.4f  sum(market)=%.4f\n", sum(my_probs), sum(mkt_devig)))
    cat(sprintf("  divergence: JS-distance=%.4f (gate %.2f -> %s) ; TV=%.4f\n",
                jsd, DIVERGENCE_FIRE, if (gate_div) "PASS" else "fail", tvd))
    cat(sprintf("  anomaly: smoke(pm25=%s>=%.0f)=%s ; obs_past_edge(run_max=%sF)=%s%s -> %s\n",
                ifelse(is.finite(pm25), sprintf("%.1f", pm25), "NA"), ANOMALY_PM25, anom_smoke,
                ifelse(is.finite(run_max), sprintf("%.1f", run_max), "NA"), anom_obs,
                if (length(anom_obs_bins)) sprintf(" [stale:%s]", paste(anom_obs_bins, collapse=",")) else "",
                if (gate_anom) "PASS" else "fail"))
    cat(sprintf("  net-edge arithmetic (best bin %s): my_prob %.3f - price %.3f - fee %.3f = %+.4f (gate %.2f -> %s)\n",
                bins$bin_id[best_i], my_probs[best_i], mkt_mids[best_i], best_fee, best_net,
                MIN_NET_EDGE, if (gate_edge) "PASS" else "fail"))
    cat(sprintf("  ==> %s  (div=%s AND anomaly=%s AND edge=%s)\n",
                decision, gate_div, gate_anom, gate_edge))
    cat("  (read-only: proposal for human review — no order placed)\n")
  }

  list(decision = decision, station = station, date = date,
       my_probs = my_probs, market = mkt_devig, bins = bins$bin_id,
       jsd = jsd, tvd = tvd, anomaly = anomaly, anom_smoke = anom_smoke,
       anom_obs = anom_obs, best_bin = bins$bin_id[best_i],
       best_net_edge = best_net, best_fee = best_fee,
       gates = c(divergence = gate_div, anomaly = gate_anom, edge = gate_edge),
       provisional_bias = pd$provisional_bias)
}

# Score every un-scored / all rows in daily.csv (read-only).
score_all <- function() {
  d <- read_csv_safe(paths()$daily)
  if (is.null(d)) { cat("no daily.csv found\n"); return(invisible()) }
  invisible(lapply(seq_len(nrow(d)), function(i) score_row(d[i, , drop = FALSE])))
}

# =============================================================================
# SELFTEST — offline; builds one FIRE and one NO-FIRE synthetic row.
# =============================================================================
selftest <- function() {
  set_seed(); lib_selfcheck()
  bins_lab <- c("<=83", "84-85", "86-87", "88-89", "90-91", "92-93", ">=94")

  mk_row <- function(members, devig, mids, pm25 = NA, run_max = NA) {
    data.frame(station = "chi_midway", date = "2026-08-15", fc_model = "archive",
      fc_member_max_csv = paste(members, collapse = ";"),
      mkt_bins_csv = paste(bins_lab, collapse = ";"),
      mkt_devig_csv = paste(round(devig, 4), collapse = ";"),
      mkt_mids_csv = paste(round(mids, 4), collapse = ";"),
      smoke_pm25 = pm25, obs_running_max_tempF = run_max, stringsAsFactors = FALSE)
  }

  cat("\n--- Case A: agreement, no anomaly -> NO-FIRE ---")
  # members cluster ~90; market also centred ~90; no anomaly
  memsA <- rnorm(20, 88, 1.5)                      # archive+Aug bias +2.5 -> ~90.5
  devigA <- c(.02, .06, .16, .26, .28, .16, .06); devigA <- devigA/sum(devigA)
  midsA <- devigA * 1.06                            # add vig back for prices
  rA <- score_row(mk_row(round(memsA,1), devigA, midsA))
  stopifnot(rA$decision == "NO-FIRE")

  cat("\n--- Case B: smoke onset + obs-past-edge + divergence -> FIRE ---")
  # My model (bias-corrected) says cooler-than-market because smoke suppresses
  # the high; market still fat on high bins; intraday max already above a low bin
  # the market still prices. Members centre ~86 (settled will be lower due smoke).
  memsB <- rnorm(20, 83.5, 1.2)                    # +2.5 -> ~86
  devigB <- c(.02, .05, .10, .18, .30, .22, .13); devigB <- devigB/sum(devigB)
  midsB <- devigB * 1.06
  rB <- score_row(mk_row(round(memsB,1), devigB, midsB, pm25 = 120, run_max = 84))
  stopifnot(rB$decision == "FIRE", rB$anom_smoke)     # fires via observable smoke

  cat("\n--- Case C: obs already past a bin edge the market still prices -> FIRE ---")
  # Intraday max already 88F, so <=83/84-85/86-87 are IMPOSSIBLE, yet the market
  # still prices 86-87 at 0.15. No smoke; the anomaly is purely observational.
  memsC <- rnorm(20, 89.5, 1.2)                    # +2.5 -> ~92 (my mass high)
  devigC <- c(.02, .04, .15, .10, .12, .27, .30); devigC <- devigC/sum(devigC)
  midsC <- devigC * 1.06
  rC <- score_row(mk_row(round(memsC,1), devigC, midsC, pm25 = NA, run_max = 88))
  stopifnot(rC$anom_obs, !rC$anom_smoke)

  cat(sprintf("\n[selftest] A=%s B=%s C=%s\n", rA$decision, rB$decision, rC$decision))
  for (r in list(rA, rB, rC))
    stopifnot(abs(sum(r$my_probs) - 1) < 1e-9, max(r$my_probs) <= MAX_BIN_CAP + 1e-9)
  cat("[selftest] all distributions sum to 1; no bin exceeds cap; both anomaly paths wired.\n")
  cat("[selftest] PASS\n")
  invisible(TRUE)
}

main <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  if ("--selftest" %in% args) { selftest(); return(invisible()) }
  set_seed(); lib_selfcheck()
  get_opt <- function(flag, default = NA) {
    i <- which(args == flag); if (length(i) && i < length(args)) args[i + 1] else default
  }
  station <- get_opt("--station", NA); date <- get_opt("--date", NA)
  d <- read_csv_safe(paths()$daily)
  if (is.null(d)) { cat("no daily.csv found — run collector.R first\n"); return(invisible()) }
  if (!is.na(station) && !is.na(date)) {
    row <- d[d$station == station & d$date == date, , drop = FALSE]
    if (nrow(row) == 0L) { cat("no matching row\n"); return(invisible()) }
    score_row(row[1, , drop = FALSE])
  } else score_all()
  invisible()
}

if (.invoked_directly("bust_detector.R")) main()
