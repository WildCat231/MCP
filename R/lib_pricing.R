# =============================================================================
# lib_pricing.R  —  FROZEN SHARED LIBRARY  (base R + jsonlite only)
# -----------------------------------------------------------------------------
# ONE source of truth for every money-critical computation in the pipeline.
# collector.R, bust_detector.R and validate.R all `source()` this file and must
# NEVER re-implement any function defined here (no re-implementation drift).
#
# Everything in this file is deterministic and side-effect-free EXCEPT the
# clearly-marked IO and NETWORK helpers. No function here places orders, holds a
# credential, or moves money. Read-only re: money by construction.
#
# Design decisions carried forward (locked; see task spec):
#   * Kalshi settles the Chicago daily-high market at MIDWAY (KMDW / CLIMDW),
#     NOT O'Hare, NOT the Romeoville/LOT office.
#   * Open-Meteo *archive* runs cold vs settled high, seasonally. A bias fit on
#     reanalysis does NOT transfer to a live forecast model — corrections are
#     stored per-model AND per-month and are NEVER applied across models.
#   * Irreducible residual SD after bias removal ~= 2.3 F ~= one bin width; live
#     error is WIDER. Mass is spread over ~3 bins; never ~90% on one bin.
#   * Fees are quadratic in price, worst mid-range (near 50c) -> favour wings.
#
# All thresholds below are DOCUMENTED PLACEHOLDER CONSTANTS, not fitted values.
# Fitting any of them is a "stop and ask the human" action (see spec).
# =============================================================================

suppressWarnings(suppressMessages(library(jsonlite)))

PIPELINE_VERSION <- "0.1.0"

# TRUE only when `Rscript <basename>` invoked this exact file, so scripts run
# main() when executed but stay inert when source()d (by tests or each other).
.invoked_directly <- function(basename_expected) {
  a <- commandArgs(FALSE)
  f <- sub("^--file=", "", a[grep("^--file=", a)])
  length(f) > 0L && basename(f[1]) == basename_expected
}

# --- Reproducibility ---------------------------------------------------------
# Every entrypoint calls set_seed() so any bootstrap / jitter is deterministic.
PIPELINE_SEED <- 20260814L
set_seed <- function(seed = PIPELINE_SEED) set.seed(seed)

# =============================================================================
# 1. CONFIG: paths, allowlist, station table
# =============================================================================

# Data root. Override with env KALSHI_DATA_DIR (selftests point this at a tmp
# dir so synthetic data is NEVER written into the production append logs).
data_dir <- function() {
  d <- Sys.getenv("KALSHI_DATA_DIR", unset = "")
  if (!nzchar(d)) d <- file.path(getwd(), "data")
  d
}

# Declared write paths. NOTHING in this pipeline writes outside data_dir().
paths <- function() {
  d <- data_dir()
  list(
    root           = d,
    forecast_trace = file.path(d, "forecast_trace.csv"),  # append-only, timestamped
    market_trace   = file.path(d, "market_trace.csv"),    # append-only, timestamped
    obs_trace      = file.path(d, "obs_trace.csv"),       # append-only, timestamped
    anomaly_trace  = file.path(d, "anomaly_trace.csv"),   # append-only, timestamped
    daily          = file.path(d, "daily.csv"),           # UPSERT: one row / station-day
    upload_hook    = file.path(d, "manual_uploads"),      # documented NA upload hook dir
    reports        = file.path(d, "reports"),             # validate.R analysis outputs
    reliability_png= file.path(d, "reports", "reliability_diagram.png"),
    validate_report= file.path(d, "reports", "validate_report.txt")
  )
}

# ---------------------------------------------------------------------------
# NETWORK ALLOWLIST. On a host that is not on this list the fetch helper STOPS
# and reports; it NEVER silently substitutes another source (spec constraint).
# ---------------------------------------------------------------------------
ALLOWED_HOSTS <- c(
  "ensemble-api.open-meteo.com",   # live ensemble forecast (per-member hourly temp)
  "archive-api.open-meteo.com",    # reanalysis archive (bias-reference ONLY)
  "api.elections.kalshi.com",      # Kalshi public market data (READ ONLY)
  "api.weather.gov",               # NWS intraday obs + CLI settlement truth
  "api.openaq.org",                # PM2.5 / smoke proxy (key often required -> NA+hook)
  "firms.modaps.eosdis.nasa.gov"   # active fire / AOD (key required -> NA+hook)
)

# Station registry. The Chicago row encodes the LOCKED settlement facts.
STATIONS <- list(
  chi_midway = list(
    station_id = "chi_midway",
    name       = "Chicago Midway",
    icao       = "KMDW",              # NWS API station id
    cli_product= "CLIMDW",            # NWS CLI product for exact-degree truth
    lat        = 41.786,
    lon        = -87.752,
    tz         = "America/Chicago",
    kalshi_series = "KXHIGHCHI"       # Kalshi daily-high series (Chicago)
  )
)

get_station <- function(station_id) {
  s <- STATIONS[[station_id]]
  if (is.null(s)) stop(sprintf("unknown station_id '%s'", station_id))
  s
}

# =============================================================================
# 2. THRESHOLDS & MODEL CONSTANTS  (documented placeholders — NOT fitted)
# =============================================================================

# -- Fees ---------------------------------------------------------------------
# Kalshi general trading fee is quadratic in price:
#   fee_per_contract = roundup_to_cent( FEE_COEF * price * (1 - price) )
# price*(1-price) peaks at price = 0.50, so net edge is worst mid-range and best
# in the wings. FEE_COEF is Kalshi's published general coefficient (placeholder;
# some series differ — verify per series before trading).
FEE_COEF <- 0.07

# -- Market microstructure ----------------------------------------------------
OVERROUND_EXPECTED <- 0.06   # ~+6% vig; de-vig by normalising mids to sum 1.

# -- Distribution shaping -----------------------------------------------------
# Hindsight residual SD after per-month/per-model bias removal (~ one bin width).
WIDEN_RESID_SD  <- 2.3       # degrees F. Floor on predictive SD (hindsight).
# Live forecast error is WIDER than hindsight. Inflate member spread before
# adding the residual floor. Placeholder multiplier, to be re-derived from live
# out-of-sample error once enough forward rows exist.
WIDEN_LIVE_INFL <- 1.30
# Never concentrate: hard cap on any single bin's probability. If a raw
# predictive dist would exceed this, SD is inflated until it complies. This
# operationalises "spread over ~3 bins; never ~90% on one bin."
MAX_BIN_CAP     <- 0.60

# -- Detector firing gates (bust_detector.R) ----------------------------------
# FIRE requires ALL THREE: large divergence AND an observable anomaly AND net
# edge that clears vig + quadratic fees. Placeholders, deliberately conservative.
DIVERGENCE_FIRE <- 0.15      # min Jensen-Shannon distance (0..1) mine vs market
MIN_NET_EDGE    <- 0.03      # min net edge in $ (3c/contract) after fees
ANOMALY_REQUIRED<- TRUE      # observable-anomaly gate (never fire on model alone)
# Observable-anomaly thresholds (also placeholders, not fitted):
ANOMALY_PM25      <- 55.0    # ug/m3 PM2.5 ~ wildfire-smoke onset (suppresses highs)
OBS_FLOOR_MKTPROB <- 0.10    # market still pricing >10% on a bin the realised
                             # intraday max has ALREADY ruled out (obs past edge)

# -- Validation --------------------------------------------------------------
MIN_N_VALIDATE  <- 100L      # below this, report "insufficient N" and DO NOT
                             # advertise a Sharpe/edge as real.
BLOCK_LEN_DAYS  <- 5L        # block length for block bootstrap on autocorr P&L.
N_BOOT          <- 2000L     # bootstrap resamples.

# =============================================================================
# 3. PER-MONTH / PER-MODEL BIAS  (settled_high - model_raw), degrees F
# =============================================================================
# Positive value == model runs COLD (settled high is warmer) -> ADD to raw.
# Tables are keyed by MODEL. There is deliberately no default/fallback: asking
# for a model with no table is an ERROR, so a reanalysis-fit correction can
# never leak onto a live model.
#
# `archive` = Open-Meteo ERA5 archive (reanalysis) measured seasonal cold bias
#   (-1 F Jan ... -2.5 F Aug, i.e. add +1 ... +2.5). Bias-REFERENCE only.
# `ensemble_live` = live Open-Meteo ensemble. Its correction MUST be fit from
#   the live model's OWN forward history; until that exists we ship an explicit
#   ZERO table flagged provisional, rather than borrowing the archive numbers.
BIAS_TABLE <- list(
  archive = c(1.0, 1.2, 1.4, 1.6, 1.8, 2.1, 2.4, 2.5, 2.3, 1.8, 1.4, 1.1),
  ensemble_live = rep(0.0, 12)   # PROVISIONAL: fit from live OOS history first.
)
# Models whose bias is still provisional (zeros) — surfaced by callers so a
# zero correction is never mistaken for a validated one.
BIAS_PROVISIONAL <- c("ensemble_live")

bias_lookup <- function(model, month) {
  stopifnot(month >= 1L, month <= 12L)
  tbl <- BIAS_TABLE[[model]]
  if (is.null(tbl)) {
    stop(sprintf(
      "no bias table for model '%s' — refusing to transfer another model's fit",
      model))
  }
  tbl[[month]]
}

# Bias-correct a raw model temperature. `month` is 1..12 of the target date.
bias_correct <- function(temp_f, model, month) {
  temp_f + bias_lookup(model, month)
}

# =============================================================================
# 4. BINS  (2 F wide + two open-ended wings; mutually exclusive & exhaustive)
# =============================================================================
# A bin spec is a data.frame with columns: bin_id, lo, hi (integer-degree
# INCLUSIVE bounds on the settled high; wings use lo=-Inf or hi=+Inf).
# Kalshi bins settle on the integer daily-high degree.

# Build a canonical Chicago-style ladder: two wings + interior 2F bins.
# `centers_lo` are the lower integer edges of interior bins, e.g. c(84,86,88).
make_bins <- function(interior_lo, width = 2L) {
  interior_lo <- as.integer(sort(interior_lo))
  lo <- integer(0); hi <- integer(0); id <- character(0)
  # bottom wing: everything at or below (first interior lo - 1)
  bot_hi <- interior_lo[1] - 1L
  lo <- c(lo, -Inf);            hi <- c(hi, bot_hi)
  id <- c(id, sprintf("<=%d", bot_hi))
  for (l in interior_lo) {
    h <- l + width - 1L
    lo <- c(lo, l); hi <- c(hi, h)
    id <- c(id, sprintf("%d-%d", l, h))
  }
  # top wing
  top_lo <- interior_lo[length(interior_lo)] + width
  lo <- c(lo, top_lo); hi <- c(hi, Inf)
  id <- c(id, sprintf(">=%d", top_lo))
  data.frame(bin_id = id, lo = lo, hi = hi, stringsAsFactors = FALSE)
}

# Reconstruct a bin spec data.frame from captured market labels ("<=83",
# "84-85", ">=94"). Inverse of the labelling in make_bins / collector.
bins_from_labels <- function(labels) {
  lo <- numeric(0); hi <- numeric(0)
  for (lab in labels) {
    if (grepl("^<=", lab)) { lo <- c(lo, -Inf); hi <- c(hi, as.numeric(sub("^<=", "", lab))) }
    else if (grepl("^>=", lab)) { lo <- c(lo, as.numeric(sub("^>=", "", lab))); hi <- c(hi, Inf) }
    else { pr <- as.numeric(strsplit(lab, "-")[[1]]); lo <- c(lo, pr[1]); hi <- c(hi, pr[2]) }
  }
  o <- order(lo)
  data.frame(bin_id = labels[o], lo = lo[o], hi = hi[o], stringsAsFactors = FALSE)
}

# Which bin does an integer settled high fall in? Returns bin_id (or NA).
bin_assign <- function(temp_f, bins) {
  if (is.na(temp_f)) return(NA_character_)
  idx <- which(temp_f >= bins$lo & temp_f <= bins$hi)
  if (length(idx) != 1L) return(NA_character_)
  bins$bin_id[idx]
}

# Continuous edges for probability integration: an integer bin [lo,hi] covers
# the continuous interval [lo-0.5, hi+0.5).
.cont_lo <- function(lo) ifelse(is.infinite(lo), -Inf, lo - 0.5)
.cont_hi <- function(hi) ifelse(is.infinite(hi),  Inf, hi + 0.5)

# =============================================================================
# 5. PREDICTIVE DISTRIBUTION over bins from ensemble members
# =============================================================================
# Pipeline: per-member daily max -> bias-correct each member (per-month/model)
# -> centre = mean, spread = widened member SD (floored at residual SD) ->
# Gaussian bin integration -> enforce non-concentration cap.

# Widen a raw member SD: inflate for live error, then add residual floor in
# quadrature. mode = "live" (default) or "hindsight".
widen_sd <- function(member_sd, mode = c("live", "hindsight")) {
  mode <- match.arg(mode)
  member_sd <- ifelse(is.na(member_sd) | member_sd < 0, 0, member_sd)
  infl <- if (mode == "live") WIDEN_LIVE_INFL else 1.0
  sqrt((member_sd * infl)^2 + WIDEN_RESID_SD^2)
}

# Gaussian probability mass per bin. Returns numeric vector aligned to bins$bin_id
# and guaranteed to sum to 1 (wings absorb the tails).
bin_probabilities <- function(mu, sd, bins) {
  sd <- max(sd, 1e-6)
  clo <- .cont_lo(bins$lo); chi <- .cont_hi(bins$hi)
  p <- pnorm(chi, mu, sd) - pnorm(clo, mu, sd)
  p[p < 0] <- 0
  s <- sum(p)
  if (s <= 0) return(rep(1 / nrow(bins), nrow(bins)))
  p / s
}

# Enforce the non-concentration cap by inflating SD until no bin exceeds the
# cap. Returns list(probs, sd_used, widened). This is what makes "never ~90% on
# one bin" a structural guarantee rather than a hope.
enforce_spread <- function(mu, sd, bins, cap = MAX_BIN_CAP, max_iter = 200L) {
  s <- max(sd, 1e-6)
  p <- bin_probabilities(mu, s, bins)
  it <- 0L
  while (max(p) > cap && it < max_iter) {
    s <- s * 1.05         # widen 5% per step
    p <- bin_probabilities(mu, s, bins)
    it <- it + 1L
  }
  list(probs = p, sd_used = s, widened = (it > 0L))
}

# Full pipeline: members -> predictive bin distribution. Returns a rich list.
predictive_distribution <- function(members_daily_max, model, month, bins,
                                     mode = "live") {
  m <- members_daily_max[is.finite(members_daily_max)]
  if (length(m) == 0L) stop("no finite ensemble members")
  corrected <- bias_correct(m, model, month)
  mu  <- mean(corrected)
  raw_sd <- if (length(corrected) > 1L) sd(corrected) else 0
  wsd <- widen_sd(raw_sd, mode = mode)
  es  <- enforce_spread(mu, wsd, bins)
  list(
    mu = mu, member_sd = raw_sd, widened_sd = wsd, sd_used = es$sd_used,
    probs = es$probs, bins = bins, capped = es$widened,
    provisional_bias = model %in% BIAS_PROVISIONAL,
    n_members = length(m)
  )
}

# =============================================================================
# 6. MARKET: mids, de-vig, fees, net edge
# =============================================================================

mid_price <- function(bid, ask) {
  # cents or dollars agnostic; caller keeps units consistent. NA-safe.
  ifelse(is.na(bid) & is.na(ask), NA_real_,
    ifelse(is.na(bid), ask,
      ifelse(is.na(ask), bid, (bid + ask) / 2)))
}

# De-vig: normalise per-bin mids to a proper distribution summing to 1. This
# strips the ~+6% overround under the (documented) assumption of proportional
# vig across mutually-exclusive bins.
devig <- function(mids) {
  mids[is.na(mids)] <- 0
  s <- sum(mids)
  if (s <= 0) return(rep(NA_real_, length(mids)))
  mids / s
}

# Kalshi quadratic fee, dollars per contract, rounded UP to the next cent.
# price is in dollars (0..1). Peaks at price = 0.50.
kalshi_fee <- function(price, coef = FEE_COEF) {
  price <- pmin(pmax(price, 0), 1)
  ceiling(coef * price * (1 - price) * 100) / 100
}

# Net edge, dollars per contract, for BUYING a YES bin at `price` when our
# probability is `my_prob`. EV = my_prob*1 - price - fee(price).
net_edge_buy <- function(my_prob, price, coef = FEE_COEF) {
  my_prob - price - kalshi_fee(price, coef)
}

# =============================================================================
# 7. DIVERGENCE between two distributions over the same bins
# =============================================================================
.norm <- function(p) { p[is.na(p)] <- 0; s <- sum(p); if (s <= 0) p else p / s }

kl_div <- function(p, q, eps = 1e-9) {
  p <- .norm(p); q <- .norm(q)
  p <- pmin(pmax(p, eps), 1); q <- pmin(pmax(q, eps), 1)
  sum(p * log(p / q))
}

# Total-variation distance (0..1): half the L1 gap. Interpretable as max prob
# disagreement on any event.
tv_dist <- function(p, q) { p <- .norm(p); q <- .norm(q); 0.5 * sum(abs(p - q)) }

# Jensen-Shannon DISTANCE (0..1, symmetric, sqrt of JS divergence in bits).
# This is the primary divergence scalar the detector gates on.
js_distance <- function(p, q, eps = 1e-9) {
  p <- .norm(p); q <- .norm(q)
  m <- 0.5 * (p + q)
  jsd <- 0.5 * kl_div(p, m, eps) + 0.5 * kl_div(q, m, eps)  # nats
  jsd_bits <- jsd / log(2)
  sqrt(max(jsd_bits, 0))
}

# =============================================================================
# 7b. DETECTOR DECISION  (the money-critical firing rule — single source)
# =============================================================================
# Pure function shared IDENTICALLY by bust_detector.R (display) and validate.R
# (scoring), so the FIRE rule can never drift between the two. Inputs are the
# aligned per-bin market vectors plus the ensemble members and observables.
# FIRE iff: divergence large AND an observable anomaly AND best net edge clears
# vig + quadratic fees.
detector_score <- function(members, model, month, bins, mkt_devig, mkt_mids,
                           pm25 = NA_real_, run_max = NA_real_, mode = "live") {
  pd  <- predictive_distribution(members, model, month, bins, mode = mode)
  my  <- pd$probs
  jsd <- js_distance(my, mkt_devig)
  tvd <- tv_dist(my, mkt_devig)
  anom_smoke <- is.finite(pm25) && pm25 >= ANOMALY_PM25
  ruled_out  <- is.finite(bins$hi) & is.finite(run_max) & (bins$hi < run_max)
  stale      <- ruled_out & (mkt_devig > OBS_FLOOR_MKTPROB)
  stale[is.na(stale)] <- FALSE
  anom_obs   <- any(stale)
  anomaly    <- anom_smoke || anom_obs
  net    <- net_edge_buy(my, mkt_mids)
  best_i <- which.max(net)
  gate_div  <- jsd >= DIVERGENCE_FIRE
  gate_anom <- (!ANOMALY_REQUIRED) || anomaly
  gate_edge <- is.finite(net[best_i]) && net[best_i] >= MIN_NET_EDGE
  fire <- gate_div && gate_anom && gate_edge
  list(decision = if (fire) "FIRE" else "NO-FIRE",
       my_probs = my, pd = pd, jsd = jsd, tvd = tvd,
       anomaly = anomaly, anom_smoke = anom_smoke, anom_obs = anom_obs,
       stale_bins = bins$bin_id[which(stale)],
       net = net, best_i = best_i, best_net = net[best_i],
       best_fee = kalshi_fee(mkt_mids[best_i]),
       gate_div = gate_div, gate_anom = gate_anom, gate_edge = gate_edge)
}

# =============================================================================
# 8. BRIER SCORE + Murphy decomposition (validate.R)
# =============================================================================
# Multi-class Brier over K bins: mean squared error between forecast prob
# vectors and one-hot outcomes. Lower is better.
#   probs_mat: N x K forecast matrix (rows sum to 1)
#   outcomes : length-N integer bin index of the realised bin (1..K)
brier_multiclass <- function(probs_mat, outcomes) {
  N <- nrow(probs_mat); K <- ncol(probs_mat)
  oh <- matrix(0, N, K); oh[cbind(seq_len(N), outcomes)] <- 1
  mean(rowSums((probs_mat - oh)^2))
}

# Murphy 3-component decomposition of the (per-event, binary) Brier for the
# FIRED contract's YES leg: reliability - resolution + uncertainty.
# f = forecast prob of the event, y = 0/1 outcome. Bins forecasts into `nbins`.
brier_decomp <- function(f, y, nbins = 10L) {
  ok <- is.finite(f) & is.finite(y)
  f <- f[ok]; y <- y[ok]
  N <- length(f)
  obar <- mean(y)
  brier <- mean((f - y)^2)
  uncertainty <- obar * (1 - obar)
  if (N == 0L) return(list(brier=NA, reliability=NA, resolution=NA,
                           uncertainty=NA, n=0L))
  br <- cut(f, breaks = seq(0, 1, length.out = nbins + 1L),
            include.lowest = TRUE)
  rel <- 0; res <- 0
  for (lv in levels(br)) {
    sel <- br == lv; nk <- sum(sel)
    if (nk == 0L) next
    fk <- mean(f[sel]); ok_ <- mean(y[sel])
    rel <- rel + nk * (fk - ok_)^2
    res <- res + nk * (ok_ - obar)^2
  }
  rel <- rel / N; res <- res / N
  list(brier = brier, reliability = rel, resolution = res,
       uncertainty = uncertainty, n = N,
       # identity check: brier ~= reliability - resolution + uncertainty
       identity_gap = brier - (rel - res + uncertainty))
}

# =============================================================================
# 9. BLOCK BOOTSTRAP on autocorrelated P&L  (validate.R)
# =============================================================================
# Moving-block bootstrap mean CI. IID bootstrap understates variance on
# autocorrelated daily P&L, so we resample contiguous blocks of BLOCK_LEN_DAYS.
block_bootstrap_mean <- function(x, block_len = BLOCK_LEN_DAYS,
                                 n_boot = N_BOOT, conf = 0.95) {
  x <- x[is.finite(x)]
  n <- length(x)
  if (n < 2L) return(list(mean = if (n) mean(x) else NA_real_, lo = NA_real_,
                          hi = NA_real_, se = NA_real_, n = n,
                          block_len = max(1L, min(block_len, max(n, 1L))),
                          n_boot = n_boot))
  block_len <- max(1L, min(block_len, n))
  nblocks <- ceiling(n / block_len)
  starts_max <- n - block_len + 1L
  means <- numeric(n_boot)
  for (b in seq_len(n_boot)) {
    idx <- integer(0)
    for (k in seq_len(nblocks)) {
      s <- sample.int(starts_max, 1L)
      idx <- c(idx, s:(s + block_len - 1L))
    }
    idx <- idx[seq_len(n)]
    means[b] <- mean(x[idx])
  }
  a <- (1 - conf) / 2
  list(mean = mean(x),
       lo = as.numeric(quantile(means, a)),
       hi = as.numeric(quantile(means, 1 - a)),
       se = sd(means), n = n, block_len = block_len, n_boot = n_boot)
}

# Deflated Sharpe: Sharpe adjusted for the number of trials tested (guards
# against selecting the best of many strategies by luck). Returns annual-ish
# Sharpe on the P&L series plus a deflated probability the true Sharpe > 0.
deflated_sharpe <- function(x, n_trials = 1L) {
  x <- x[is.finite(x)]; n <- length(x)
  if (n < 3L || sd(x) == 0) return(list(sharpe = NA, dsr = NA, n = n))
  sr <- mean(x) / sd(x)                     # per-observation Sharpe
  # skew/kurtosis-aware SE of Sharpe (Bailey & Lopez de Prado)
  g3 <- mean((x - mean(x))^3) / sd(x)^3
  g4 <- mean((x - mean(x))^4) / sd(x)^4
  se_sr <- sqrt((1 - g3 * sr + (g4 - 1) / 4 * sr^2) / (n - 1))
  # expected max Sharpe under the null across n_trials (approx, Gaussian EV of
  # the max of n_trials i.i.d. standard normals)
  emc <- 0.5772156649
  z <- if (n_trials > 1L)
         (1 - emc) * qnorm(1 - 1 / n_trials) + emc * qnorm(1 - 1 / (n_trials * exp(1)))
       else 0
  sr0 <- z * se_sr
  dsr <- pnorm((sr - sr0) / se_sr)
  list(sharpe = sr, se = se_sr, dsr = dsr, n = n, n_trials = n_trials)
}

# =============================================================================
# 10. IO helpers  (SIDE EFFECTS — the only stateful part of the library)
# =============================================================================
ensure_dir <- function(path) {
  d <- if (grepl("/", path)) dirname(path) else path
  if (!dir.exists(d)) dir.create(d, recursive = TRUE, showWarnings = FALSE)
}

read_csv_safe <- function(path) {
  if (!file.exists(path)) return(NULL)
  df <- tryCatch(
    read.csv(path, stringsAsFactors = FALSE, colClasses = "character"),
    error = function(e) NULL)
  df
}

# Atomic write: temp file + rename, so a crash mid-write can't corrupt a CSV.
write_csv_atomic <- function(df, path) {
  ensure_dir(path)
  tmp <- paste0(path, ".tmp.", Sys.getpid())
  write.csv(df, tmp, row.names = FALSE, na = "")
  file.rename(tmp, path)
  invisible(path)
}

# Pure append (trace logs). Aligns columns to any existing header.
append_row <- function(path, row) {
  ensure_dir(path)
  row <- as.data.frame(row, stringsAsFactors = FALSE)
  existing <- read_csv_safe(path)
  if (is.null(existing)) {
    write_csv_atomic(row, path)
  } else {
    all_cols <- union(names(existing), names(row))
    for (c in setdiff(all_cols, names(existing))) existing[[c]] <- NA
    for (c in setdiff(all_cols, names(row)))      row[[c]]      <- NA
    existing <- existing[, all_cols, drop = FALSE]
    row      <- row[, all_cols, drop = FALSE]
    write_csv_atomic(rbind(existing, row), path)
  }
  invisible(path)
}

# Idempotent UPSERT by key columns: one row per key. Running the collector
# twice for the same station-day updates the SAME row instead of duplicating —
# this is what satisfies "run twice/day -> no duplicate rows".
upsert_row <- function(path, key_cols, row) {
  ensure_dir(path)
  row <- as.data.frame(row, stringsAsFactors = FALSE)
  existing <- read_csv_safe(path)
  if (is.null(existing)) {
    write_csv_atomic(row, path)
    return(invisible("insert"))
  }
  all_cols <- union(names(existing), names(row))
  for (c in setdiff(all_cols, names(existing))) existing[[c]] <- NA
  for (c in setdiff(all_cols, names(row)))      row[[c]]      <- NA
  existing <- existing[, all_cols, drop = FALSE]
  row      <- row[, all_cols, drop = FALSE]
  key_match <- rep(TRUE, nrow(existing))
  for (k in key_cols)
    key_match <- key_match & (as.character(existing[[k]]) == as.character(row[[k]][1]))
  if (any(key_match)) {
    existing[which(key_match)[1], ] <- row[1, ]     # replace-in-place (upsert)
    existing <- existing[!(key_match & seq_len(nrow(existing)) != which(key_match)[1]), , drop = FALSE]
    write_csv_atomic(existing, path)
    invisible("update")
  } else {
    write_csv_atomic(rbind(existing, row), path)
    invisible("insert")
  }
}

# =============================================================================
# 11. NETWORK helpers  (shell to curl; enforce allowlist; treat body as DATA)
# =============================================================================
host_of <- function(url) {
  h <- sub("^[a-zA-Z]+://", "", url)
  h <- sub("/.*$", "", h)
  h <- sub(":.*$", "", h)
  tolower(h)
}

is_allowed <- function(url) host_of(url) %in% ALLOWED_HOSTS

# GET via curl. Returns list(ok, status, body, host, error). On a host that is
# NOT allowlisted this STOPS (spec: do not substitute a source). On network
# failure it returns ok=FALSE (caller degrades to NA — never fabricates).
http_get <- function(url, headers = c(), timeout = 20L, user_agent = NULL) {
  h <- host_of(url)
  if (!(h %in% ALLOWED_HOSTS)) {
    stop(sprintf("host_not_allowed: '%s' is not on the allowlist — STOPPING (no substitute source).", h))
  }
  args <- c("-sS", "--max-time", as.character(timeout),
            "-w", "\n%{http_code}")
  if (!is.null(user_agent)) args <- c(args, "-A", user_agent)
  if (length(headers))
    for (nm in names(headers)) args <- c(args, "-H", sprintf("%s: %s", nm, headers[[nm]]))
  args <- c(args, url)
  # system2() concatenates args into one string and runs it via /bin/sh, so
  # every arg (esp. the -w "%{http_code}" format and the URL query string) MUST
  # be shell-quoted or the shell mangles it.
  out <- tryCatch(
    system2("curl", args = shQuote(args), stdout = TRUE, stderr = TRUE),
    error = function(e) NULL)
  if (is.null(out)) return(list(ok = FALSE, status = NA, body = NA, host = h,
                                error = "curl invocation failed"))
  st <- attr(out, "status")
  if (!is.null(st) && st != 0L)
    return(list(ok = FALSE, status = NA, body = NA, host = h,
                error = sprintf("curl exit %s", st)))
  txt <- paste(out, collapse = "\n")
  # last line is the http_code we appended with -w
  lines <- strsplit(txt, "\n", fixed = TRUE)[[1]]
  status <- suppressWarnings(as.integer(tail(lines, 1)))
  body <- paste(head(lines, -1), collapse = "\n")
  ok <- !is.na(status) && status >= 200 && status < 300
  list(ok = ok, status = status, body = body, host = h,
       error = if (ok) NA_character_ else sprintf("http_status=%s", status))
}

# Parse JSON body defensively; treat as DATA, never eval. Returns NULL on error.
parse_json <- function(body) {
  if (is.null(body) || is.na(body) || !nzchar(body)) return(NULL)
  tryCatch(jsonlite::fromJSON(body, simplifyVector = TRUE),
           error = function(e) NULL)
}

# =============================================================================
# 12. Sanity self-check for the library itself (invariants that must hold)
# =============================================================================
lib_selfcheck <- function() {
  bins <- make_bins(c(84, 86, 88, 90, 92))
  stopifnot(nrow(bins) == 7L)                      # 5 interior + 2 wings
  stopifnot(bin_assign(89L, bins) == "88-89")
  stopifnot(bin_assign(70L, bins) == "<=83")
  stopifnot(bin_assign(99L, bins) == ">=94")
  p <- bin_probabilities(88, 2.3, bins)
  stopifnot(abs(sum(p) - 1) < 1e-9)
  es <- enforce_spread(88, 0.2, bins)              # tiny sd must be widened
  stopifnot(max(es$probs) <= MAX_BIN_CAP + 1e-9, es$widened)
  stopifnot(abs(sum(devig(c(0.55, 0.35, 0.16))) - 1) < 1e-9)  # de-vig sums to 1
  stopifnot(kalshi_fee(0.5) >= kalshi_fee(0.05))   # fee worst mid-range
  stopifnot(abs(js_distance(p, p)) < 1e-9)         # zero self-divergence
  # bias table must refuse unknown model (no cross-model transfer)
  bad <- tryCatch({ bias_lookup("nope", 8L); FALSE }, error = function(e) TRUE)
  stopifnot(bad)
  invisible(TRUE)
}
