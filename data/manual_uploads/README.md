# Manual upload hook (smoke / anomaly inputs)

When no allowlisted smoke/AOD source is reachable or authorised, `collector.R`
writes a **NA** value for that column rather than fabricating one. This is the
documented hook to supply the value by hand later — the collector ingests a file
here on its next run instead of inventing data.

Drop a JSON file named:

```
smoke_<station>_<YYYY-MM-DD>.json
```

e.g. `smoke_chi_midway_2026-08-15.json`, containing:

```json
{ "pm25": 132.0, "source": "manual: AirNow Midway sensor", "note": "wildfire smoke" }
```

Only `pm25` is required (µg/m³). The collector records `status = manual_upload`
and the provided value. Nothing here is auto-generated; an absent file simply
leaves the column NA, which is the honest state.
