# Changelog

All notable changes to this project are recorded here.

---

## [3.1.0] - 2026-03-22

### Fixed
- **KV write throttling to prevent free tier quota exhaustion** — the worker was writing two KV keys per site on every cron execution (one `status:` and one `history:` key), resulting in up to 2,880 writes/day with a single site
  at the default 1-minute trigger — nearly three times the Cloudflare free tier limit of 1,000 writes/day. The root cause was that KV writes were tied to the cron trigger frequency rather than to dashboard view requests as originally
  intended. Fixed by introducing a configurable throttle gate (`KV_WRITE_INTERVAL_MINUTES`, default `5`) that allows WP-Cron to keep firing every minute while limiting KV writes to once every 5 minutes (576 writes/day
  for a single site). The gate uses `event.scheduledTime` for deterministic, wall-clock-aligned write decisions. Dashboard status data will be at most `KV_WRITE_INTERVAL_MINUTES` minutes stale, which has no practical impact on
  monitoring. Users with multiple sites should consider increasing the interval further — each additional site adds 2 KV writes per throttled tick.

## [3.0.0] — 2026-03-05

### Consolidation

This release merges the previously separate single-site and multi-site branches into a single, unified codebase on `main`. There is now one Worker, one README, and one CHANGELOG.

**Why this was done:**

The two branches had diverged into a maintenance problem. Any bug fix or improvement needed to be applied twice, and the distinction between them was largely artificial — the multi-site Worker already handled a single site correctly when `WP_CRON_SITES` contained just one entry. Keeping a separate, simpler version offered no practical advantage and created confusion about which branch to use.

**What changed:**

- The single-site branch (`main`) and multi-site branch have been merged. The multi-site Worker is now the sole version, renamed simply as the WordPress Cron Worker.
- All references to "single-site" and "multi-site" have been removed from the code, comments, README, and CHANGELOG. The Worker is described as handling "one or more sites" throughout.
- The README has been rewritten as a single setup guide, with clearly labelled single-site and multi-site JSON examples side by side under the same instructions.
- The KV dashboard and status tracking features — previously introduced in the multi-site branch — are now documented as standard features available to all users regardless of how many sites they manage.
- The `archive/single-site` branch and `v1.0-single-site` tag are preserved in the repository as a permanent reference to the previous single-site implementation.

**What did not change:**

- The `worker.js` logic is identical to v2.0.2. No functional changes were made to the scheduled handler, KV integration, dashboard renderer, or fetch handler.
- Existing deployments require no changes. Environment variables, KV bindings, and Cron Trigger schedules all remain valid.

### Fixes (carried over from review during consolidation)

- **Corrected timeout value in README.** The Troubleshooting table previously stated a 10-second timeout; the actual value in the Worker has always been 25 seconds (`REQUEST_TIMEOUT_MS = 25_000`). The README now reflects the correct value.
- **Corrected fetch handler behaviour in README.** The Notes section previously stated that direct HTTP requests to the Worker URL return `403 Forbidden`. In reality, the fetch handler returns a JSON status message with HTTP 200. The note has been corrected.
- **Updated User-Agent header** from `Cloudflare-Worker-WP-Cron/2.0` to `Cloudflare-Worker-WP-Cron/3.0` to reflect the version bump.
- **Updated dashboard page title** from "WP Cron — Multi-Site Dashboard" to "WP Cron Dashboard".

---

## [2.0.2] — 2026-03-04

### Bug fixes

- **Fixed** `parseSites()` to handle `WP_CRON_SITES` delivered as a pre-parsed object when the variable type is set to **JSON** in the Cloudflare Dashboard, in addition to the existing plain string/text type.
- **Added** `?kv=status` and `?kv=history` now return a styled HTML dashboard when accessed from a browser, with status cards and a run history table per site. API and curl requests continue to receive raw JSON as before.

## [2.0.1] — 2026-03-03

### Bug fixes

- **Added missing `fetch` handler.** Cloudflare requires every Worker to export a `fetch` handler, even if the Worker is cron-only. Without it, any direct HTTP request to the Worker URL — including Cloudflare's own dashboard preview — would produce a runtime exception (`Handler does not export a fetch() function`). The Worker now returns a JSON status message for all HTTP requests.

- **Fixed `WP_CRON_SITES` parsing when added as a JSON binding.** If `WP_CRON_SITES` was added in the Cloudflare dashboard as a **JSON** binding type (rather than a Secret), Cloudflare pre-parses the value before passing it to the Worker, making `JSON.parse()` fail with `"[object Obj"... is not valid JSON`. The Worker now checks `typeof env.WP_CRON_SITES` and skips `JSON.parse()` if the value is already an object. Both binding types are now handled correctly, though **Secret** remains the recommended type as documented.

### Added

- **KV namespace binding** (`WP_CRON_KV`) — the Worker now writes the result
  of every cron run to Cloudflare KV storage for monitoring and diagnostics.
- `status:<hostname>` key — stores the latest run result per site (HTTP status,
  success flag, timestamps, response preview, error message if any).
- `history:<hostname>` key — stores a rolling log of the last 10 runs per site,
  newest first.
- All KV entries auto-expire after 48 hours — no manual cleanup needed.
- Built-in HTTP dashboard: append `?kv=status` or `?kv=history` to the Worker
  URL to read stored data as JSON. Filter by site with `&site=example.com`.
- KV is fully optional — if the binding is not configured, the Worker continues
  to function exactly as before with no errors.

---

## [2.0.0] — 2025-02-19

### Breaking changes

- **Renamed environment variable** from `MULTISITE_SITES` to `WP_CRON_SITES`.  
  Update the variable name in your Worker's Settings → Variables and Secrets.

- **Renamed JSON field** from `domain` to `url` inside the `WP_CRON_SITES` array.  
  Update every entry in your JSON from `{ "domain": "...", "key": "..." }` to `{ "url": "...", "key": "..." }`.  
  The values themselves do not change — only the field name.

### Bug fixes

- **Fixed critical runtime error:** `safeText()` was called in `worker.js` on non-OK HTTP responses but was never defined in the file (it only appeared in the README code block). Any HTTP error from a WordPress site would have caused a `ReferenceError: safeText is not defined` crash. The function is now correctly included in `worker.js`.

### Improvements

- **Parallel execution.** Sites are now triggered in parallel using `Promise.allSettled` instead of one after another. This means the total run time is roughly equal to the slowest individual site, not the sum of all sites.

- **Request timeout.** Each site fetch now has a 25-second timeout via `AbortController`. A slow or unresponsive site will no longer hang the Worker indefinitely.

- **URL validation.** The Worker now checks each entry before attempting a fetch and logs a clear error message if the `url` or `key` field is missing or malformed.

- **Improved log output.** Log messages are more descriptive. A summary line at the end of each run shows how many sites succeeded and how many failed.

- **Response body capped in error logs.** When a site returns an error, the Worker reads up to 500 characters of the response body for debugging, instead of attempting to read the full (potentially large) error page.

### README

- Rewrote all sections for clarity. Plain English throughout, with no assumed knowledge of Cloudflare internals.
- Added an explanation of why offloading WP-Cron to a Worker is beneficial.
- Updated Apache configuration from the deprecated Apache 2.2 `Order Deny,Allow` syntax to the current Apache 2.4 `Require` directive.
- Recommended using **Secret** type (not Plain text) for `WP_CRON_SITES`, since it contains authentication keys.
- Added a Testing section covering Wrangler local testing and the Cloudflare Past Events log.
- Expanded the Troubleshooting table with more specific symptoms, causes, and fixes.
- Added a Notes and limitations section covering UTC timing, the 3-trigger limit, parallel execution behaviour, and log retention.
- Removed the embedded copy of `worker.js` from the README to avoid the file getting out of sync with the actual `worker.js`.
