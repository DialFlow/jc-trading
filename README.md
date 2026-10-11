# 1-minute candle archive (ES, NQ)

Written by `.github/workflows/archive-1m.yml` (main branch) every weekday after the close. `1m/<ES|NQ>/<YYYY-MM-DD>.json` = `[[t, o, h, l, c], ...]`, t in UTC seconds, grouped by Eastern calendar date, Yahoo `ES=F` / `NQ=F` (front month). Backfilled from Sep 11, 2026.
