#!/usr/bin/env Rscript
# =============================================================================
# collector.R  —  idempotent DAILY forward collector  (base R + jsonlite)
# -----------------------------------------------------------------------------
# Writes ONE row per (station, date) into data/daily.csv (idempotent UPSERT, so
# running twice a day never duplicates a row) plus append-only timestamped
# trace logs. Collects, per station-day:
#   * live ensemble forecast (ensemble-api.open-meteo.com) -> per-member daily max
#   * live Kalshi bins + prices (api.elections.kalshi.com) -> de-vigged probs + ts
#   * intraday obs trace (api.weather.gov) for nowcasting
#   * smoke / anomaly inputs from ALLOWLISTED hosts only; on failure a NA column
#     is written plus a documented manual-upload hook — data is NEVER fabricated
#   * finalized settled truth (NWS CLI final + Kalshi winning bin) written back
#     to CLOSE the row.
#
# READ-ONLY re: money. No credentials, no orders. All hosts allowlist-gated.
#
# Usage:
#   Rscript collector.R --station chi_midway            # collect today (open row)
#   Rscript collector.R --station chi_midway --date 2026-08-15
#   Rscript collector.R --station chi_midway --settle 2026-08-14  # close a past day
#   Rscript collector.R --selftest                       # offline, temp dir only
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

now_iso <- function() format(as.POSIXct(Sys.time(), tz = "UTC"), "%Y-%m-%dT%H:%M:%SZ")
today_for <- function(station) {
  s <- get_station(station)
  format(as.Date(as.POSIXct(Sys.time()), tz = s$tz), "%Y-%m-%d")
}
month_of <- function(date) as.integer(format(as.Date(date), "%m"))
c_to_f <- function(c) c * 9 / 5 + 32

# =============================================================================
# FORECAST — Open-Meteo ensemble: per-member hourly temp -> per-member daily max
# =============================================================================
# `parse_ensemble` takes the ALREADY-PARSED json object so it is unit-testable
# offline with a synthetic fixture. Returns list(members=<numeric per-member
# daily max>, model, n_members) or a degraded NA result.
parse_ensemble <- function(obj, target_date, model = "ensemble_live") {
  if (is.null(obj) || is.null(obj$hourly) || is.null(obj$hourly$time))
    return(list(members = NA_real_, model = model, n_members = 0L, ok = FALSE))
  h <- obj$hourly
  day <- substr(as.character(h$time), 1, 10)
  sel <- day == target_date
  if (!any(sel)) return(list(members = NA_real_, model = model, n_members = 0L, ok = FALSE))
  # member columns are named temperature_2m_memberNN (+ the base temperature_2m)
  cols <- grep("^temperature_2m", names(h), value = TRUE)
  if (!length(cols)) return(list(members = NA_real_, model = model, n_members = 0L, ok = FALSE))
  maxes <- vapply(cols, function(cn) {
    v <- suppressWarnings(as.numeric(h[[cn]][sel]))
    if (all(is.na(v))) NA_real_ else max(v, na.rm = TRUE)
  }, numeric(1))
  maxes <- maxes[is.finite(maxes)]
  list(members = as.numeric(maxes), model = model, n_members = length(maxes), ok = length(maxes) > 0L)
}

fetch_ensemble <- function(station, target_date) {
  s <- get_station(station)
  url <- sprintf(paste0("https://ensemble-api.open-meteo.com/v1/ensemble?",
                        "latitude=%.4f&longitude=%.4f&hourly=temperature_2m",
                        "&models=gfs_seamless&temperature_unit=fahrenheit",
                        "&timezone=%s&start_date=%s&end_date=%s"),
                 s$lat, s$lon, utils::URLencode(s$tz, reserved = TRUE),
                 target_date, target_date)
  r <- http_get(url)
  if (!isTRUE(r$ok)) return(list(members = NA_real_, model = "ensemble_live",
                                 n_members = 0L, ok = FALSE, error = r$error))
  parse_ensemble(parse_json(r$body), target_date)
}

# =============================================================================
# MARKET — Kalshi bins + prices -> mids -> de-vig
# =============================================================================
# Bin bounds from the market's own strikes (the market defines the ladder).
kalshi_bin_bounds <- function(m) {
  fs <- suppressWarnings(as.numeric(m$floor_strike))
  cs <- suppressWarnings(as.numeric(m$cap_strike))
  lo <- if (length(fs) && is.finite(fs)) fs else -Inf
  hi <- if (length(cs) && is.finite(cs)) cs else Inf
  id <- if (is.infinite(lo)) sprintf("<=%g", hi)
        else if (is.infinite(hi)) sprintf(">=%g", lo)
        else sprintf("%g-%g", lo, hi)
  list(bin_id = id, lo = lo, hi = hi)
}

# `parse_market` takes the parsed markets json. Prices from Kalshi are in CENTS.
# Returns a data.frame per bin with mid (dollars) + de-vigged prob, or NULL.
parse_market <- function(obj) {
  ms <- obj$markets
  if (is.null(ms) || (is.data.frame(ms) && nrow(ms) == 0L)) return(NULL)
  if (is.data.frame(ms)) {
    rows <- lapply(seq_len(nrow(ms)), function(i) as.list(ms[i, , drop = FALSE]))
  } else rows <- ms
  recs <- lapply(rows, function(m) {
    b <- kalshi_bin_bounds(m)
    yb <- suppressWarnings(as.numeric(m$yes_bid))
    ya <- suppressWarnings(as.numeric(m$yes_ask))
    mid_c <- mid_price(yb, ya)                   # cents
    data.frame(bin_id = b$bin_id, lo = b$lo, hi = b$hi,
               yes_bid = yb, yes_ask = ya,
               mid = ifelse(is.na(mid_c), NA_real_, mid_c / 100),  # dollars
               ticker = if (!is.null(m$ticker)) as.character(m$ticker) else NA,
               stringsAsFactors = FALSE)
  })
  df <- do.call(rbind, recs)
  df <- df[order(df$lo), , drop = FALSE]
  df$devig <- devig(df$mid)
  df$overround <- sum(df$mid, na.rm = TRUE) - 1   # expected ~ +0.06
  df
}

fetch_market <- function(station) {
  s <- get_station(station)
  url <- sprintf("https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=%s&status=open&limit=200",
                 s$kalshi_series)
  r <- http_get(url)
  if (!isTRUE(r$ok)) return(NULL)
  parse_market(parse_json(r$body))
}

# =============================================================================
# OBS — NWS intraday observation (nowcasting) + running daily max
# =============================================================================
parse_obs_latest <- function(obj) {
  p <- obj$properties
  if (is.null(p)) return(list(obs_time = NA, temp_f = NA_real_, ok = FALSE))
  tc <- suppressWarnings(as.numeric(p$temperature$value))
  list(obs_time = if (!is.null(p$timestamp)) as.character(p$timestamp) else NA,
       temp_f = if (is.finite(tc)) c_to_f(tc) else NA_real_,
       ok = is.finite(tc))
}

fetch_obs <- function(station) {
  s <- get_station(station)
  url <- sprintf("https://api.weather.gov/stations/%s/observations/latest", s$icao)
  # NWS requires a descriptive User-Agent.
  r <- http_get(url, user_agent = "kalshi-temp-research (research; contact via repo)")
  if (!isTRUE(r$ok)) return(list(obs_time = NA, temp_f = NA_real_, ok = FALSE, error = r$error))
  parse_obs_latest(parse_json(r$body))
}

# =============================================================================
# SMOKE / ANOMALY — allowlisted hosts only; else NA + documented upload hook.
# NEVER fabricate. If no source is reachable/authorised we record NA and point
# at the manual-upload hook directory so a human can drop a file in later.
# =============================================================================
collect_smoke <- function(station, target_date) {
  # OpenAQ / FIRMS typically require an API key we deliberately do NOT hold.
  # Try OpenAQ latest PM2.5 near the station; on any failure -> NA + hook.
  s <- get_station(station)
  hook <- file.path(paths()$upload_hook,
                    sprintf("smoke_%s_%s.json", station, target_date))
  url <- sprintf("https://api.openaq.org/v2/latest?coordinates=%.4f,%.4f&radius=25000&parameter=pm25",
                 s$lat, s$lon)
  r <- tryCatch(http_get(url), error = function(e) list(ok = FALSE, error = conditionMessage(e)))
  pm25 <- NA_real_; status <- "unavailable"; src <- NA_character_
  if (isTRUE(r$ok)) {
    obj <- parse_json(r$body)
    val <- tryCatch(obj$results$measurements[[1]]$value[1], error = function(e) NA)
    if (is.finite(suppressWarnings(as.numeric(val)))) {
      pm25 <- as.numeric(val); status <- "openaq"; src <- "api.openaq.org"
    }
  }
  # If a human dropped a manual file in the hook dir, ingest it (still not fabricated).
  if (is.na(pm25) && file.exists(hook)) {
    obj <- parse_json(paste(readLines(hook, warn = FALSE), collapse = "\n"))
    if (!is.null(obj$pm25) && is.finite(suppressWarnings(as.numeric(obj$pm25)))) {
      pm25 <- as.numeric(obj$pm25); status <- "manual_upload"; src <- "upload_hook"
    }
  }
  list(pm25 = pm25, aod = NA_real_, source = src, status = status, hook = hook)
}

# =============================================================================
# SETTLEMENT — close a row with exact-degree truth (NWS CLI) + Kalshi bin
# =============================================================================
# Parse the daily-max out of an NWS CLI text product. CLI "YESTERDAY" section
# reports the settlement max; a corrected product supersedes.
parse_cli_max <- function(cli_text) {
  if (is.null(cli_text) || is.na(cli_text) || !nzchar(cli_text)) return(NA_integer_)
  lines <- strsplit(cli_text, "\n", fixed = TRUE)[[1]]
  # find the MAXIMUM row in the TEMPERATURE block: "MAXIMUM   91   ..."
  mx <- NA_integer_
  for (ln in lines) {
    if (grepl("^\\s*MAXIMUM", ln, ignore.case = TRUE)) {
      num <- regmatches(ln, regexpr("-?[0-9]+", ln))
      if (length(num)) { mx <- as.integer(num); break }
    }
  }
  mx
}

fetch_cli_max <- function(station, target_date) {
  # NWS products: latest CLI for the station's location code (MDW).
  loc <- sub("^K", "", get_station(station)$cli_product)   # CLIMDW -> MDW
  loc <- sub("^CLI", "", get_station(station)$cli_product)  # CLIMDW -> MDW
  url <- sprintf("https://api.weather.gov/products/types/CLI/locations/%s", loc)
  r <- http_get(url, user_agent = "kalshi-temp-research (research; contact via repo)")
  if (!isTRUE(r$ok)) return(NA_integer_)
  idx <- parse_json(r$body)
  graph <- if (!is.null(idx[["@graph"]])) idx[["@graph"]] else idx$graph
  pid <- tryCatch(as.character(graph$id[1]), error = function(e) NA)
  if (is.na(pid)) return(NA_integer_)
  r2 <- http_get(pid, user_agent = "kalshi-temp-research (research; contact via repo)")
  if (!isTRUE(r2$ok)) return(NA_integer_)
  parse_cli_max(tryCatch(parse_json(r2$body)$productText, error = function(e) NA))
}

# =============================================================================
# ROW ASSEMBLY + WRITE
# =============================================================================
csv_join <- function(x) paste(ifelse(is.na(x), "", as.character(x)), collapse = ";")

collect_once <- function(station, target_date, fixtures = NULL) {
  s <- get_station(station)
  mo <- month_of(target_date)
  ts <- now_iso()
  p <- paths()

  # --- gather (fixtures short-circuit the network for --selftest) ---
  fc  <- if (!is.null(fixtures$ensemble)) parse_ensemble(fixtures$ensemble, target_date)
         else fetch_ensemble(station, target_date)
  mkt <- if (!is.null(fixtures$market)) parse_market(fixtures$market)
         else fetch_market(station)
  obs <- if (!is.null(fixtures$obs)) parse_obs_latest(fixtures$obs)
         else fetch_obs(station)
  smk <- if (!is.null(fixtures$smoke)) fixtures$smoke
         else collect_smoke(station, target_date)

  # --- append-only trace logs ---
  append_row(p$forecast_trace, data.frame(
    ts = ts, station = station, date = target_date, model = fc$model,
    n_members = fc$n_members, member_max_csv = csv_join(fc$members),
    mu_raw = if (fc$n_members > 0) mean(fc$members) else NA_real_,
    stringsAsFactors = FALSE))

  if (!is.null(mkt)) {
    for (i in seq_len(nrow(mkt))) {
      append_row(p$market_trace, data.frame(
        ts = ts, station = station, date = target_date,
        bin_id = mkt$bin_id[i], yes_bid = mkt$yes_bid[i], yes_ask = mkt$yes_ask[i],
        mid = mkt$mid[i], devig = mkt$devig[i], overround = mkt$overround[i],
        stringsAsFactors = FALSE))
    }
  }
  append_row(p$obs_trace, data.frame(
    ts = ts, station = station, date = target_date,
    obs_time = obs$obs_time, temp_f = obs$temp_f, stringsAsFactors = FALSE))

  append_row(p$anomaly_trace, data.frame(
    ts = ts, station = station, date = target_date, source = smk$source,
    metric = "pm25", value = smk$pm25, status = smk$status,
    stringsAsFactors = FALSE))

  # --- running daily-max obs from the obs trace (nowcast state) ---
  ot <- read_csv_safe(p$obs_trace)
  run_max <- NA_real_
  if (!is.null(ot)) {
    sub <- ot[ot$station == station & ot$date == target_date, ]
    v <- suppressWarnings(as.numeric(sub$temp_f))
    if (any(is.finite(v))) run_max <- max(v, na.rm = TRUE)
  }

  # --- upsert the ONE daily row (open state; settlement fills later) ---
  existing <- read_csv_safe(p$daily)
  run_count <- 1L
  if (!is.null(existing)) {
    m <- existing$station == station & existing$date == target_date
    if (any(m)) run_count <- suppressWarnings(as.integer(existing$run_count[which(m)[1]])) + 1L
  }

  row <- data.frame(
    station = station, date = target_date, tz = s$tz,
    collected_at = ts, run_count = run_count,
    fc_model = fc$model, fc_n_members = fc$n_members,
    fc_member_max_csv = csv_join(fc$members),
    fc_mu_raw = if (fc$n_members > 0) mean(fc$members) else NA_real_,
    fc_provisional_bias = fc$model %in% BIAS_PROVISIONAL,
    mkt_ts = if (!is.null(mkt)) ts else NA_character_,
    mkt_bins_csv = if (!is.null(mkt)) csv_join(mkt$bin_id) else NA_character_,
    mkt_mids_csv = if (!is.null(mkt)) csv_join(round(mkt$mid, 4)) else NA_character_,
    mkt_devig_csv = if (!is.null(mkt)) csv_join(round(mkt$devig, 4)) else NA_character_,
    mkt_overround = if (!is.null(mkt)) mkt$overround[1] else NA_real_,
    obs_latest_ts = obs$obs_time, obs_latest_tempF = obs$temp_f,
    obs_running_max_tempF = run_max,
    smoke_pm25 = smk$pm25, smoke_aod = smk$aod,
    smoke_source = smk$source, smoke_status = smk$status,
    settled = 0L, settle_high_f = NA_real_, settle_bin = NA_character_,
    settle_source = NA_character_, settled_at = NA_character_,
    stringsAsFactors = FALSE)

  act <- upsert_row(p$daily, c("station", "date"), row)
  list(action = act, run_count = run_count, fc = fc, mkt = mkt, obs = obs, smoke = smk,
       run_max = run_max)
}

# Close a row: write settled truth back (NWS CLI exact degree + Kalshi bin).
settle_day <- function(station, target_date, fixtures = NULL) {
  p <- paths()
  existing <- read_csv_safe(p$daily)
  if (is.null(existing) || !any(existing$station == station & existing$date == target_date))
    stop(sprintf("no open row for %s %s to settle", station, target_date))
  high_f <- if (!is.null(fixtures$cli_text)) parse_cli_max(fixtures$cli_text)
            else fetch_cli_max(station, target_date)
  # winning bin: prefer the market ladder captured for this row; else canonical ladder
  row_i <- which(existing$station == station & existing$date == target_date)[1]
  bins_csv <- existing$mkt_bins_csv[row_i]
  settle_bin <- NA_character_
  if (is.finite(high_f)) {
    if (!is.na(bins_csv) && nzchar(bins_csv)) {
      settle_bin <- kalshi_bin_from_labels(strsplit(bins_csv, ";")[[1]], high_f)
    }
  }
  r <- existing[row_i, , drop = FALSE]
  r$settled <- 1L
  r$settle_high_f <- high_f
  r$settle_bin <- settle_bin
  r$settle_source <- "nws_cli_final"
  r$settled_at <- now_iso()
  upsert_row(p$daily, c("station", "date"), r)
  list(high_f = high_f, settle_bin = settle_bin)
}

# Map an integer high to a bin label from a captured market ladder (labels like
# "<=83","84-85",">=94").
kalshi_bin_from_labels <- function(labels, temp_f) {
  for (lab in labels) {
    if (grepl("^<=", lab)) { hi <- as.numeric(sub("^<=", "", lab)); if (temp_f <= hi) return(lab) }
    else if (grepl("^>=", lab)) { lo <- as.numeric(sub("^>=", "", lab)); if (temp_f >= lo) return(lab) }
    else if (grepl("-", lab)) {
      pr <- as.numeric(strsplit(lab, "-")[[1]]); if (temp_f >= pr[1] && temp_f <= pr[2]) return(lab)
    }
  }
  NA_character_
}

# =============================================================================
# SELFTEST — offline, synthetic fixtures, TEMP dir only (never touches prod data)
# =============================================================================
selftest <- function() {
  set_seed()
  td <- tempfile("collector_selftest_"); dir.create(td)
  Sys.setenv(KALSHI_DATA_DIR = td)
  station <- "chi_midway"; date <- "2026-08-15"
  cat("[selftest] data dir:", td, "\n")

  # synthetic ensemble: 20 members, hourly across the target day, ~ high 90F
  hrs <- sprintf("%sT%02d:00", date, 0:23)
  mk_member <- function(peak) round(peak - 8 * (abs((0:23) - 15) / 15), 1)  # peak ~15:00
  ens <- list(hourly = c(list(time = hrs),
    setNames(lapply(1:20, function(i) mk_member(88 + rnorm(1, 0, 1.5))),
             sprintf("temperature_2m_member%02d", 1:20))))

  # synthetic Kalshi ladder around 90F, prices in cents, with ~+6% overround
  strikes <- seq(84, 94, by = 2)
  markets <- data.frame(
    ticker = sprintf("KXHIGHCHI-T%d", strikes),
    floor_strike = strikes, cap_strike = strikes + 1,
    yes_bid = c(2, 6, 18, 33, 22, 8), yes_ask = c(4, 9, 22, 37, 26, 11),
    stringsAsFactors = FALSE)
  mkt_obj <- list(markets = markets)

  obs_obj <- list(properties = list(timestamp = sprintf("%sT14:53:00Z", date),
                                    temperature = list(value = 31.7)))  # ~89F
  smoke <- list(pm25 = NA_real_, aod = NA_real_, source = NA_character_,
                status = "unavailable", hook = "hook")

  fx <- list(ensemble = ens, market = mkt_obj, obs = obs_obj, smoke = smoke)

  r1 <- collect_once(station, date, fixtures = fx)
  r2 <- collect_once(station, date, fixtures = fx)   # second run same day
  d <- read_csv_safe(paths()$daily)
  ndup <- sum(d$station == station & d$date == date)
  cat(sprintf("[selftest] run1=%s run2=%s ; daily rows for %s %s = %d (run_count=%s)\n",
              r1$action, r2$action, station, date, ndup, d$run_count[1]))
  stopifnot(ndup == 1L)                              # NO duplicate rows

  # de-vig sanity from captured row
  dv <- as.numeric(strsplit(d$mkt_devig_csv[1], ";")[[1]])
  cat(sprintf("[selftest] market de-vig sums to %.6f ; overround=%.4f\n",
              sum(dv), as.numeric(d$mkt_overround[1])))
  stopifnot(abs(sum(dv) - 1) < 1e-6)

  # smoke unavailable -> NA + hook documented, not fabricated
  cat(sprintf("[selftest] smoke_pm25=%s status=%s (NA is honest, not fabricated)\n",
              d$smoke_pm25[1], d$smoke_status[1]))
  stopifnot(is.na(suppressWarnings(as.numeric(d$smoke_pm25[1]))))

  # settlement writeback (synthetic CLI final: high 91)
  cli <- paste("...", "TEMPERATURE (F)", "  MAXIMUM   91   259 PM", "...", sep = "\n")
  st <- settle_day(station, date, fixtures = list(cli_text = cli))
  d2 <- read_csv_safe(paths()$daily)
  cat(sprintf("[selftest] settled high=%s winning_bin=%s settled_flag=%s ; still %d row(s)\n",
              st$high_f, st$settle_bin, d2$settled[1], sum(d2$date == date)))
  stopifnot(sum(d2$date == date) == 1L, d2$settled[1] == "1", st$high_f == 91,
            st$settle_bin == "90-91")

  # allowlist enforcement: a non-allowlisted host must STOP
  stopped <- tryCatch({ http_get("https://evil.example.com/x"); FALSE },
                      error = function(e) grepl("host_not_allowed", conditionMessage(e)))
  cat(sprintf("[selftest] non-allowlisted host stops: %s\n", stopped))
  stopifnot(stopped)

  cat("[selftest] PASS\n")
  invisible(TRUE)
}

# =============================================================================
# CLI
# =============================================================================
main <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  get_opt <- function(flag, default = NA) {
    i <- which(args == flag); if (length(i) && i < length(args)) args[i + 1] else default
  }
  if ("--selftest" %in% args) { selftest(); return(invisible()) }

  set_seed()
  lib_selfcheck()
  station <- get_opt("--station", "chi_midway")
  settle_date <- get_opt("--settle", NA)
  if (!is.na(settle_date)) {
    st <- settle_day(station, settle_date)
    cat(sprintf("[settle] %s %s -> high=%s bin=%s\n", station, settle_date,
                st$high_f, st$settle_bin))
    return(invisible())
  }
  date <- get_opt("--date", today_for(station))
  r <- collect_once(station, date)
  cat(sprintf("[collect] %s %s action=%s run=%d fc_members=%d mkt_bins=%s obs=%sF run_max=%sF smoke=%s\n",
              station, date, r$action, r$run_count, r$fc$n_members,
              if (!is.null(r$mkt)) nrow(r$mkt) else 0,
              r$obs$temp_f, r$run_max, r$smoke$status))
  invisible()
}

# Run main() ONLY when this file is the script Rscript was invoked with, so the
# file can be safely source()d (e.g. by tests) without triggering live collection.
if (.invoked_directly("collector.R")) main()
