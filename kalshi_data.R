#!/usr/bin/env Rscript
# =============================================================================
# kalshi_data.R — Kalshi Data Layer (public, read-only, key-free)
#
# Produces a tidy per-market-day dataset joining Kalshi implied-price history to
# realized outcomes for a DAILY-resolving temperature series (default KXHIGHNY).
#
# BOUNDARY (enforced, not aspirational):
#   This file PREDICTS ONLY. It calls public market-data endpoints exclusively.
#   It never authenticates, never sends an order, never touches a portfolio
#   endpoint, and never reads a credential. `assert_public_path()` below hard
#   fails on any path that looks authed. Do not remove that guard.
#
# MODES
#   live    — hit the Kalshi REST API (DEMO base URL by default)
#   fixture — deterministic simulator, used when the API is unreachable
#   auto    — try live, fall back to fixture (default)
#
# The downstream schema is IDENTICAL in both modes, so model.R / backtest.R /
# hmm.R neither know nor care which produced the data.
# =============================================================================

suppressPackageStartupMessages({
  library(httr2); library(jsonlite); library(dplyr); library(tibble); library(lubridate)
})

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

KD <- list(
  # DEMO base URL per the task brief. Prod is api.elections.kalshi.com.
  # NOTE: docs.kalshi.com is egress-blocked in this environment, so these paths
  # could NOT be confirmed against the live spec. They follow the documented v2
  # layout. Each is flagged with its verification status — check before trusting
  # `live` mode in anger.
  base_url_demo = "https://demo-api.kalshi.co/trade-api/v2",
  base_url_prod = "https://api.elections.kalshi.com/trade-api/v2",
  use_demo      = TRUE,

  series_ticker = "KXHIGHNY",   # NYC daily high temp. See market_selection.md.
  station       = "KNYC",       # settlement station (NWS Central Park)

  # Rate limiting. Kalshi's published read tier is well above this; we throttle
  # conservatively because the rate-limit doc was unreachable and being polite is
  # cheaper than being banned.
  rate_per_sec  = 5,
  max_retries   = 4,
  timeout_sec   = 30,

  cache_dir     = "data/raw",
  out_dir       = "data",
  page_limit    = 200,          # cursor page size
  mode          = "auto"
)

base_url <- function() if (KD$use_demo) KD$base_url_demo else KD$base_url_prod

# ---------------------------------------------------------------------------
# Guard rail: refuse anything that is not public market data
# ---------------------------------------------------------------------------

PRIVATE_PATH_PATTERNS <- c(
  "portfolio", "orders", "fills", "positions", "balance", "login",
  "logout", "account", "settlements/me", "exchange/user"
)

assert_public_path <- function(path) {
  low <- tolower(path)
  hit <- PRIVATE_PATH_PATTERNS[vapply(PRIVATE_PATH_PATTERNS,
                                      function(p) grepl(p, low, fixed = TRUE),
                                      logical(1))]
  if (length(hit)) {
    stop(sprintf(
      "BOUNDARY VIOLATION: '%s' matches private/authed pattern '%s'. This system is predict-only.",
      path, hit[1]), call. = FALSE)
  }
  invisible(TRUE)
}

# ---------------------------------------------------------------------------
# HTTP with throttle, retry, and on-disk cache of raw JSON
# ---------------------------------------------------------------------------

cache_key <- function(path, query) {
  raw <- paste0(path, "?", paste(names(query), unlist(query), sep = "=", collapse = "&"))
  # basename-safe, collision-resistant enough for a cache
  paste0(gsub("[^A-Za-z0-9]+", "_", raw), "_",
         substr(digest_md5(raw), 1, 10), ".json")
}

# Small dependency-free MD5 (tools::md5sum works on files only; use a string hash)
digest_md5 <- function(s) {
  tf <- tempfile(); on.exit(unlink(tf), add = TRUE)
  writeLines(s, tf)
  unname(tools::md5sum(tf))
}

api_get <- function(path, query = list(), use_cache = TRUE, retries = KD$max_retries) {
  assert_public_path(path)
  dir.create(KD$cache_dir, recursive = TRUE, showWarnings = FALSE)
  cf <- file.path(KD$cache_dir, cache_key(path, query))

  if (use_cache && file.exists(cf)) {
    return(fromJSON(readLines(cf, warn = FALSE), simplifyVector = FALSE))
  }

  req <- request(paste0(base_url(), path)) |>
    req_url_query(!!!query) |>
    req_user_agent("kalshi-daily-prediction-research/0.1 (read-only)") |>
    req_timeout(KD$timeout_sec) |>
    req_throttle(rate = KD$rate_per_sec) |>
    req_retry(max_tries = retries, backoff = function(i) 2^i)

  resp <- req_perform(req)                      # errors propagate to caller
  body <- resp_body_string(resp)
  writeLines(body, cf)                          # cache raw JSON so re-runs are free
  fromJSON(body, simplifyVector = FALSE)
}

api_reachable <- function() {
  ok <- TRUE
  # single attempt, no retry ladder — this is a reachability probe, not a fetch
  tryCatch(api_get("/exchange/status", use_cache = FALSE, retries = 1),
           error = function(e) ok <<- FALSE)
  ok
}

# ---------------------------------------------------------------------------
# Cursor pagination — every list endpoint is paginated this way
# ---------------------------------------------------------------------------

paginate <- function(path, query = list(), field, max_pages = 200) {
  out <- list(); cursor <- NULL; page <- 0
  repeat {
    page <- page + 1
    q <- c(query, list(limit = KD$page_limit))
    if (!is.null(cursor) && nzchar(cursor)) q$cursor <- cursor
    js <- api_get(path, q)
    chunk <- js[[field]]
    if (!is.null(chunk) && length(chunk)) out <- c(out, chunk)
    cursor <- js$cursor
    # Last page is signalled by an absent/empty cursor, or a short page.
    if (is.null(cursor) || !nzchar(cursor) || page >= max_pages) break
  }
  out
}

# ---------------------------------------------------------------------------
# Fixed-point price normalization -> probability in [0,1]
#
# Kalshi migrated from integer cents to a finer fixed-point representation. The
# migration doc was egress-blocked, so rather than hardcode a guess we DETECT the
# scale from the observed magnitude. A price is a probability in [0,1]; whichever
# divisor maps the observed range into that interval is the right one.
# ---------------------------------------------------------------------------

detect_price_scale <- function(x) {
  x <- x[is.finite(x) & x > 0]
  if (!length(x)) return(100)
  m <- max(x)
  if (m <= 1.0)      1        # already probability
  else if (m <= 100) 100      # integer cents (legacy)
  else if (m <= 1e4) 1e4      # basis points
  else if (m <= 1e6) 1e6      # micro-units
  else 10^ceiling(log10(m))
}

to_prob <- function(x, scale = NULL) {
  if (is.null(scale)) scale <- detect_price_scale(x)
  p <- as.numeric(x) / scale
  pmin(pmax(p, 0), 1)
}

# ---------------------------------------------------------------------------
# Discovery / enumeration (live mode)
# ---------------------------------------------------------------------------

get_series <- function(ticker = KD$series_ticker) {
  api_get(sprintf("/series/%s", ticker))          # verification: unconfirmed
}

get_settled_markets <- function(ticker = KD$series_ticker) {
  paginate("/markets", list(series_ticker = ticker, status = "settled"), "markets")
}

get_historical_cutoff <- function() {
  # Splits "use the historical candlestick endpoint" from "use the live one".
  # If unavailable, fall back to a conservative cutoff of 'now', which routes
  # everything through the historical endpoint.
  tryCatch({
    js <- api_get("/exchange/historical_cutoff")
    as_datetime(js$cutoff_ts %||% js$historical_cutoff_ts)
  }, error = function(e) now(tzone = "UTC"))
}

`%||%` <- function(a, b) if (is.null(a)) b else a

get_candlesticks <- function(series_ticker, market_ticker, start_ts, end_ts,
                             historical = FALSE, period_interval = 1440) {
  path <- if (historical) {
    sprintf("/series/%s/markets/%s/candlesticks/historical", series_ticker, market_ticker)
  } else {
    sprintf("/series/%s/markets/%s/candlesticks", series_ticker, market_ticker)
  }
  api_get(path, list(start_ts = start_ts, end_ts = end_ts,
                     period_interval = period_interval))
}

# ---------------------------------------------------------------------------
# Bracket parsing — turn a market ticker / subtitle into numeric edges
#   KXHIGHNY-26AUG12-B82.5  -> [82.5, 84.5)   (2-degree bracket)
#   KXHIGHNY-26AUG12-T89.5  -> [89.5, Inf)    (tail)
# ---------------------------------------------------------------------------

parse_bracket <- function(ticker, floor_strike = NA, cap_strike = NA, width = 2) {
  suffix <- sub(".*-", "", ticker)
  kind   <- substr(suffix, 1, 1)
  val    <- suppressWarnings(as.numeric(sub("^[A-Za-z]", "", suffix)))
  if (is.finite(floor_strike) || is.finite(cap_strike)) {
    return(list(lower = ifelse(is.finite(floor_strike), floor_strike, -Inf),
                upper = ifelse(is.finite(cap_strike),   cap_strike,    Inf)))
  }
  switch(kind,
    "B" = list(lower = val, upper = val + width),  # between
    "T" = list(lower = val, upper = Inf),          # above threshold
    "A" = list(lower = val, upper = Inf),
    list(lower = -Inf, upper = val))               # below
}

# ---------------------------------------------------------------------------
# FIXTURE MODE — deterministic simulator
#
# READ THIS BEFORE BELIEVING ANY BACKTEST NUMBER.
#
# The simulator is built with the project's hypothesis DELIBERATELY TRUE by
# default: forecast-error variance is regime-switching, and the simulated market
# prices a FLAT sigma (`market_knows_regime = FALSE`). Under that setting a
# regime-aware model *must* win — that is a test of the pipeline, not evidence
# about the real world.
#
# Set `market_knows_regime = TRUE` to run the NULL: a market that already prices
# the regime. An honest report runs BOTH and says so. backtest.R does exactly
# that.
# ---------------------------------------------------------------------------

simulate_market_days <- function(n_days = 900,
                                 seed = 42,
                                 market_knows_regime = FALSE,
                                 ens_informative = TRUE,
                                 market_noise = 0.35,
                                 start_date = as.Date("2024-01-01")) {
  set.seed(seed)
  dates <- start_date + 0:(n_days - 1)
  doy   <- as.integer(format(dates, "%j"))

  # NYC Central Park climatology: ~39F mid-Jan, ~85F mid-Jul
  clim <- 62 + 23 * cos(2 * pi * (doy - 196) / 365)

  # Two-state latent regime on FORECAST DIFFICULTY (not temperature level).
  # State 1 = settled/quiescent, State 2 = disturbed. Persistent, per §2.3.
  P <- matrix(c(0.90, 0.10,
                0.22, 0.78), nrow = 2, byrow = TRUE)
  state <- integer(n_days); state[1] <- 1L
  for (t in 2:n_days) state[t] <- sample.int(2, 1, prob = P[state[t - 1], ])
  sigma_true <- c(1.6, 3.6)[state]      # true forecast-error sd, degF

  # Temperature anomaly: seasonal-heteroskedastic AR(1)
  phi <- 0.70
  anom_sd <- 4.5 + 2.0 * cos(2 * pi * (doy - 15) / 365)   # winter more variable
  anom <- numeric(n_days)
  for (t in 2:n_days) anom[t] <- phi * anom[t - 1] + rnorm(1, 0, anom_sd[t] * sqrt(1 - phi^2))

  realized <- round(clim + anom)                          # CLI reports integers

  # Forecast known in advance: truth + regime-dependent error, small warm bias
  fc_bias  <- 0.3
  forecast <- realized + rnorm(n_days, fc_bias, sigma_true)

  # Ensemble spread: an UNDERDISPERSED, noisy read on the true sd. This is the
  # canonical raw-ensemble pathology that NGR exists to correct (§2.2).
  #
  # `ens_informative = FALSE` severs the link to the regime, leaving spread as
  # pure noise. That is the ONLY world in which the HMM layer has a job to do:
  # with an informative spread, NGR already sees the regime contemporaneously and
  # the HMM's lagged estimate cannot compete. See hmm.R / REPORT.md.
  ens_sd <- if (ens_informative) {
    pmax(0.5, 0.72 * sigma_true + rnorm(n_days, 0, 0.35))
  } else {
    pmax(0.5, 0.72 * mean(sigma_true) + rnorm(n_days, 0, 0.35))
  }

  # ---- the simulated market ------------------------------------------------
  # Market centres on the forecast (de-biased) but its width either tracks the
  # regime (null) or is flat (hypothesis true).
  mkt_sigma <- if (market_knows_regime) sigma_true * 1.02 else rep(mean(sigma_true), n_days)
  mkt_mu    <- forecast - fc_bias + rnorm(n_days, 0, market_noise)

  # Brackets: 2F wide, spanning +/-8F around the forecast
  rows <- list()
  for (t in seq_len(n_days)) {
    centre <- 2 * round(forecast[t] / 2)
    lowers <- seq(centre - 8, centre + 6, by = 2) + 0.5
    for (lo in lowers) {
      up <- lo + 2
      p_true <- pnorm(up, mkt_mu[t], mkt_sigma[t]) - pnorm(lo, mkt_mu[t], mkt_sigma[t])
      # Spread widens for illiquid tail buckets; 1-3 cents.
      half_spread <- (0.005 + 0.020 * (1 - p_true))
      rows[[length(rows) + 1]] <- tibble(
        date           = dates[t],
        series_ticker  = KD$series_ticker,
        market_ticker  = sprintf("%s-%s-B%.1f", KD$series_ticker,
                                 toupper(format(dates[t], "%y%b%d")), lo),
        lower          = lo,
        upper          = up,
        implied_prob   = pmin(pmax(p_true, 1e-4), 1 - 1e-4),
        bid            = pmax(0, p_true - half_spread),
        ask            = pmin(1, p_true + half_spread),
        forecast       = forecast[t],
        ens_sd         = ens_sd[t],
        clim           = clim[t],
        realized_value = realized[t],
        regime_true    = state[t]
      )
    }
  }
  bind_rows(rows) |>
    mutate(outcome = as.integer(realized_value > lower & realized_value <= upper)) |>
    arrange(date, lower)
}

# ---------------------------------------------------------------------------
# LIVE MODE assembly
# ---------------------------------------------------------------------------

build_live <- function(ticker = KD$series_ticker) {
  message("[kalshi_data] live mode: ", base_url())
  cutoff  <- get_historical_cutoff()
  markets <- get_settled_markets(ticker)
  if (!length(markets)) stop("No settled markets returned for ", ticker)

  rows <- lapply(markets, function(m) {
    close_ts <- as_datetime(m$close_time %||% m$expiration_time)
    is_hist  <- !is.na(close_ts) && close_ts < cutoff
    cs <- tryCatch(
      get_candlesticks(ticker, m$ticker,
                       start_ts = as.integer(close_ts - days(2)),
                       end_ts   = as.integer(close_ts),
                       historical = is_hist),
      error = function(e) NULL)

    # last close price before settlement -> implied probability
    px <- NA_real_
    if (!is.null(cs) && length(cs$candlesticks)) {
      last <- cs$candlesticks[[length(cs$candlesticks)]]
      px <- suppressWarnings(as.numeric(last$price$close %||% last$yes_bid$close))
    }
    br <- parse_bracket(m$ticker,
                        floor_strike = as.numeric(m$floor_strike %||% NA),
                        cap_strike   = as.numeric(m$cap_strike   %||% NA))
    tibble(
      date           = as.Date(close_ts),
      series_ticker  = ticker,
      market_ticker  = m$ticker,
      lower          = br$lower,
      upper          = br$upper,
      implied_raw    = px,
      outcome        = as.integer(identical(tolower(m$result %||% ""), "yes")),
      realized_value = suppressWarnings(as.numeric(m$settlement_value %||% NA))
    )
  })

  out <- bind_rows(rows)
  scale <- detect_price_scale(out$implied_raw)
  message("[kalshi_data] detected price scale: ", scale)
  out |>
    mutate(implied_prob = to_prob(implied_raw, scale)) |>
    filter(is.finite(implied_prob)) |>
    arrange(date, lower)
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

load_market_days <- function(mode = KD$mode, ...) {
  if (mode == "live" || (mode == "auto" && api_reachable())) {
    tryCatch(return(build_live()),
             error = function(e) message("[kalshi_data] live failed: ", conditionMessage(e)))
  }
  if (mode == "live") stop("live mode requested but API unreachable")
  message("[kalshi_data] fixture mode (API unreachable or not requested)")
  simulate_market_days(...)
}

if (sys.nframe() == 0) {
  dir.create(KD$out_dir, recursive = TRUE, showWarnings = FALSE)
  d <- load_market_days()
  out <- file.path(KD$out_dir, "market_days.csv")
  write.csv(d, out, row.names = FALSE)
  cat(sprintf("[kalshi_data] %d rows across %d market-days -> %s\n",
              nrow(d), length(unique(d$date)), out))
  # Sanity: bracket probabilities within a day should sum to ~1
  s <- tapply(d$implied_prob, d$date, sum)
  cat(sprintf("[kalshi_data] per-day implied_prob sum: mean %.3f (sd %.3f)\n",
              mean(s), sd(s)))
}
