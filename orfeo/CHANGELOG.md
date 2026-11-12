# Changelog: GitHub Workflow Starter

## [1.0.0] — 2026-11-12

First version. Starts GitHub Actions workflows (workflow_dispatch) at a fixed local time each day from a Cloudflare Cron Trigger, with time zones and summer time, retries for 30 minutes on failure, at most one start per job per day (KV), a status dashboard with an optional key, and failures in Workers Logs. Made for the Orfeo daily stats.
