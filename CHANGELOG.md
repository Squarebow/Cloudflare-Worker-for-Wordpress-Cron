# Changelog

All notable changes to the Multi-Site version of this Worker are recorded here.

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

- **Request timeout.** Each site fetch now has a 10-second timeout via `AbortController`. A slow or unresponsive site will no longer hang the Worker indefinitely.

- **URL validation.** The Worker now checks each entry before attempting a fetch and logs a clear error message if the `url` or `key` field is missing or malformed.

- **Improved log output.** Log messages are more descriptive. A summary line at the end of each run shows how many sites succeeded and how many failed.

- **Response body capped in error logs.** When a site returns an error, the Worker reads up to 500 characters of the response body for debugging, instead of attempting to read the full (potentially large) error page.

### Naming

- The project is now referred to as the **Multi-Site** version (previously "Multi-Secure" or "multi domain"). The companion script is the **Single-Site** version. "Site" is the appropriate term because each entry represents a full WordPress installation identified by its base URL — not just a domain name.

### README

- Rewrote all sections for clarity. Plain English throughout, with no assumed knowledge of Cloudflare internals.
- Added a **Single-Site vs Multi-Site** comparison table.
- Added an explanation of why offloading WP-Cron to a Worker is beneficial.
- Clarified that "Multi-Site" refers to multiple independent WordPress installations and is unrelated to the WordPress Multisite (network) feature.
- Corrected the "How it works" URL template, which previously showed `https://{domain}/wp-cron.php` — implying the field held only a domain name, when it actually holds a full URL.
- Updated Apache configuration from the deprecated Apache 2.2 `Order Deny,Allow` syntax to the current Apache 2.4 `Require` directive.
- Recommended using **Secret** type (not Plain text) for `WP_CRON_SITES`, since it contains authentication keys.
- Added a Testing section covering Wrangler local testing and the Cloudflare Past Events log.
- Expanded the Troubleshooting table with more specific symptoms, causes, and fixes.
- Added a Notes and limitations section covering UTC timing, the 3-trigger limit, parallel execution behaviour, and log retention.
- Removed the embedded copy of `worker.js` from the README to avoid the file getting out of sync with the actual `worker.js`.
