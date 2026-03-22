/*
  Cloudflare Worker — WordPress Cron + KV Status Tracking v3.1.0
  -------------------------------------------------------------------
  Triggers wp-cron.php for one or more WordPress sites on a fixed
  schedule, and writes the result of each run to a KV namespace for
  monitoring.

  KV binding required (Settings → Variables and Secrets → KV Namespace Bindings):
    Binding name:  WP_CRON_KV
    Namespace:     create one in Workers & Pages → KV → Create namespace

  Environment variables required:
    WP_CRON_SITES  — JSON array of site objects, e.g.:
                     [
                       { "url": "https://site1.com", "key": "secret1" },
                       { "url": "https://site2.com", "key": "secret2" }
                     ]
                     A single site is also valid:
                     [
                       { "url": "https://mysite.com", "key": "my-secret" }
                     ]

  KV keys written per site (auto-expire after 48 hours):
    status:<hostname>     — latest run result (JSON)
    history:<hostname>    — last 10 run results (JSON array)

  KV write throttling:
    KV writes happen only every KV_WRITE_INTERVAL_MINUTES minutes to stay
    within the Cloudflare free tier limit of 1,000 writes/day. WP-Cron
    is still triggered every minute regardless. Dashboard data will be
    at most KV_WRITE_INTERVAL_MINUTES minutes stale.

  To read KV from the browser, visit:
    https://your-worker.workers.dev/?kv=status          → all sites, latest run
    https://your-worker.workers.dev/?kv=history         → all sites, last 10 runs
    https://your-worker.workers.dev/?kv=status&site=site1.com  → one site only
*/

// ─── Configuration ──────────────────────────────────────────────────────────

// Request timeout in milliseconds. Worker will abandon a site after this long.
const REQUEST_TIMEOUT_MS = 25_000;

// How many past runs to keep in the history log per site.
const HISTORY_MAX_ENTRIES = 10;

// KV TTL in seconds. Entries expire automatically after this period.
const KV_TTL_SECONDS = 172_800; // 48 hours

// How often (in minutes) to write status to KV.
// At every-minute cron with 1 site:
//   every 1 min  → 2,880 writes/day  ❌ exceeds free tier
//   every 5 min  →   576 writes/day  ✓ safe
//   every 10 min →   288 writes/day  ✓ very safe
// Each additional site multiplies writes by 2 (status + history keys).
// Adjust this value if you have many sites.
const KV_WRITE_INTERVAL_MINUTES = 5;


// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Safely read the response body as text without throwing.
 * Cloudflare Workers can only read a response body once,
 * and it may be empty or unreadable on network errors.
 */
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "(unreadable response body)";
  }
}

/**
 * Parse the WP_CRON_SITES environment variable and return a validated array.
 * Each entry must have a `url` (string) and optionally a `key` (string).
 */
function parseSites(env) {
  if (!env.WP_CRON_SITES) {
    throw new Error("WP_CRON_SITES environment variable is not set.");
  }

  let sites;
  // Cloudflare delivers the value pre-parsed when the variable type is set
  // to "JSON" in the Dashboard. Handle both that case and plain string.
  if (Array.isArray(env.WP_CRON_SITES)) {
    sites = env.WP_CRON_SITES;
  } else {
    try {
      sites = JSON.parse(env.WP_CRON_SITES);
    } catch {
      throw new Error("WP_CRON_SITES is not valid JSON.");
    }
  }

  if (!Array.isArray(sites) || sites.length === 0) {
    throw new Error("WP_CRON_SITES must be a non-empty JSON array.");
  }

  for (const site of sites) {
    if (!site.url || typeof site.url !== "string") {
      throw new Error(`Each site must have a "url" string. Found: ${JSON.stringify(site)}`);
    }
  }

  return sites;
}

/**
 * Build the wp-cron.php URL from a site's base URL.
 * Strips any trailing slash to avoid double-slash in the path.
 */
function buildCronUrl(siteUrl) {
  return siteUrl.replace(/\/$/, "") + "/wp-cron.php?doing_wp_cron";
}

/**
 * Extract a clean hostname from a URL for use as a KV key segment.
 * e.g. "https://www.example.com/" → "www.example.com"
 */
function hostname(siteUrl) {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}

/**
 * Returns true if the current cron tick falls on a KV write interval.
 * Uses the scheduled timestamp so the check is deterministic and aligned
 * to wall-clock minute boundaries rather than execution time drift.
 *
 * Example: KV_WRITE_INTERVAL_MINUTES = 5 → writes at :00, :05, :10 … ✓
 */
function shouldWriteKVThisTick(scheduledTime) {
  const minuteOfDay = Math.floor(scheduledTime / 1000 / 60);
  return (minuteOfDay % KV_WRITE_INTERVAL_MINUTES) === 0;
}


// ─── KV helpers ──────────────────────────────────────────────────────────────

/**
 * Write the latest run result to KV and append it to the rolling history log.
 * Both keys share the same 48-hour TTL so stale data is cleaned up automatically.
 *
 * KV keys:
 *   status:<hostname>   → single JSON object (latest run only)
 *   history:<hostname>  → JSON array (last N runs, newest first)
 */
async function writeKV(kv, siteUrl, result) {
  const host = hostname(siteUrl);
  const kvOptions = { expirationTtl: KV_TTL_SECONDS };

  // --- latest status ---
  await kv.put(
    `status:${host}`,
    JSON.stringify(result),
    kvOptions
  );

  // --- rolling history ---
  let history = [];
  try {
    const existing = await kv.get(`history:${host}`);
    if (existing) history = JSON.parse(existing);
  } catch {
    // No existing history or parse failure — start fresh.
  }

  history.unshift(result);                          // prepend latest
  history = history.slice(0, HISTORY_MAX_ENTRIES);  // cap at max entries

  await kv.put(
    `history:${host}`,
    JSON.stringify(history),
    kvOptions
  );
}

/**
 * Read all KV status or history entries and return them as a plain object
 * keyed by hostname. Used by the HTTP dashboard handler below.
 */
async function readAllKV(kv, sites, type) {
  const results = {};

  await Promise.allSettled(
    sites.map(async (site) => {
      const host = hostname(site.url);
      const value = await kv.get(`${type}:${host}`);
      results[host] = value ? JSON.parse(value) : null;
    })
  );

  return results;
}


// ─── Core cron logic ─────────────────────────────────────────────────────────

/**
 * Trigger wp-cron.php for a single site and return a structured result object.
 * All errors are caught — a single failing site must never interrupt the others.
 */
async function triggerSite(site) {
  const url = buildCronUrl(site.url);
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers = { "User-Agent": "Cloudflare-Worker-WP-Cron/3.0" };
    if (site.key) headers["X-Worker-Auth"] = site.key;

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    const body = await safeText(response);

    return {
      site: site.url,
      success: response.ok,
      status: response.status,
      body: body.slice(0, 200), // store a preview, not the full body
      startedAt,
      finishedAt: new Date().toISOString(),
      error: null,
    };

  } catch (err) {
    const isTimeout = err.name === "AbortError";
    return {
      site: site.url,
      success: false,
      status: null,
      body: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: isTimeout ? `Timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Loop through all configured sites, trigger each one in parallel,
 * and write the result to KV (throttled to KV_WRITE_INTERVAL_MINUTES).
 *
 * WP-Cron is triggered on every execution regardless of the KV throttle.
 */
async function handleScheduled(env, scheduledTime) {
  const sites = parseSites(env);

  const results = await Promise.allSettled(
    sites.map((site) => triggerSite(site))
  );

  // Write results to KV only on throttled ticks to stay within free tier limits.
  // KV_WRITE_INTERVAL_MINUTES controls the cadence (default: every 5 minutes).
  if (env.WP_CRON_KV && shouldWriteKVThisTick(scheduledTime)) {
    await Promise.allSettled(
      results.map(async (settled) => {
        if (settled.status === "fulfilled") {
          await writeKV(env.WP_CRON_KV, settled.value.site, settled.value);
        }
      })
    );
  }

  return results.map((r) =>
    r.status === "fulfilled" ? r.value : { error: r.reason?.message }
  );
}


// ─── HTML dashboard renderer ─────────────────────────────────────────────────

/**
 * Returns true if the request comes from a browser.
 * Browsers send Accept: text/html; API clients and curl typically do not.
 */
function isBrowser(request) {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/html");
}

/**
 * Render a single site status card for the HTML dashboard.
 */
function renderCard(host, entry) {
  if (!entry) {
    return `
      <div class="card unknown">
        <div class="card-header">
          <span class="hostname">${host}</span>
          <span class="badge badge-unknown">No data yet</span>
        </div>
        <p class="hint">Waiting for first cron run.</p>
      </div>`;
  }

  const success = entry.success;
  const statusCode = entry.status ?? "—";
  const error = entry.error ?? null;
  const ts = entry.finishedAt
    ? new Date(entry.finishedAt).toLocaleString("sl-SI", { timeZone: "Europe/Ljubljana" })
    : "—";

  return `
    <div class="card ${success ? "ok" : "fail"}">
      <div class="card-header">
        <span class="hostname">${host}</span>
        <span class="badge ${success ? "badge-ok" : "badge-fail"}">
          ${success ? "✓ OK" : "✗ Failed"}
        </span>
      </div>
      <div class="card-meta">
        <span>HTTP ${statusCode}</span>
        <span>${ts}</span>
      </div>
      ${error ? `<div class="card-error">${error}</div>` : ""}
    </div>`;
}

/**
 * Render a history row for a single run entry.
 */
function renderHistoryRow(entry, index) {
  const success = entry.success;
  const ts = entry.finishedAt
    ? new Date(entry.finishedAt).toLocaleString("sl-SI", { timeZone: "Europe/Ljubljana" })
    : "—";
  const statusCode = entry.status ?? "—";
  const error = entry.error ?? "";

  return `
    <tr class="${success ? "" : "row-fail"}">
      <td>${index + 1}</td>
      <td><span class="badge ${success ? "badge-ok" : "badge-fail"}">${success ? "✓ OK" : "✗ Fail"}</span></td>
      <td>${statusCode}</td>
      <td>${ts}</td>
      <td class="error-cell">${error}</td>
    </tr>`;
}

/**
 * Render the full HTML page for the dashboard.
 */
function renderHTML(type, data) {
  const now = new Date().toLocaleString("sl-SI", { timeZone: "Europe/Ljubljana" });

  let body = "";

  if (type === "status") {
    body = Object.entries(data)
      .map(([host, entry]) => renderCard(host, entry))
      .join("\n");
  } else {
    body = Object.entries(data).map(([host, entries]) => {
      if (!entries || entries.length === 0) {
        return `
          <div class="history-block">
            <h2>${host}</h2>
            <p class="hint">No history yet.</p>
          </div>`;
      }
      const rows = entries.map((e, i) => renderHistoryRow(e, i)).join("\n");
      return `
        <div class="history-block">
          <h2>${host}</h2>
          <table>
            <thead>
              <tr><th>#</th><th>Result</th><th>HTTP</th><th>Time</th><th>Error</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join("\n");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WP Cron Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f0f2f5;
      color: #1a1a2e;
      padding: 2rem;
      min-height: 100vh;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 2rem;
      flex-wrap: wrap;
      gap: 1rem;
    }

    header h1 {
      font-size: 1.4rem;
      font-weight: 700;
      color: #1a1a2e;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    header h1 span.logo {
      background: #f6821f;
      color: white;
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 0.85rem;
      font-weight: 800;
      letter-spacing: 0.03em;
    }

    .meta {
      font-size: 0.8rem;
      color: #888;
    }

    nav {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }

    nav a {
      padding: 0.4rem 1rem;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 600;
      border: 1.5px solid #d1d5db;
      color: #555;
      background: white;
      transition: all 0.15s;
    }

    nav a.active {
      background: #1a1a2e;
      color: white;
      border-color: #1a1a2e;
    }

    nav a:hover:not(.active) {
      background: #f9fafb;
      border-color: #aaa;
    }

    /* ── Status cards ── */
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }

    .card {
      background: white;
      border-radius: 10px;
      padding: 1.1rem 1.2rem;
      border-left: 4px solid #d1d5db;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }

    .card.ok   { border-left-color: #22c55e; }
    .card.fail { border-left-color: #ef4444; }
    .card.unknown { border-left-color: #d1d5db; }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
      gap: 0.5rem;
    }

    .hostname {
      font-weight: 700;
      font-size: 0.95rem;
      word-break: break-all;
    }

    .card-meta {
      display: flex;
      gap: 1rem;
      font-size: 0.78rem;
      color: #888;
      margin-top: 0.25rem;
    }

    .card-error {
      margin-top: 0.6rem;
      font-size: 0.78rem;
      color: #ef4444;
      background: #fef2f2;
      border-radius: 4px;
      padding: 0.3rem 0.5rem;
      word-break: break-word;
    }

    /* ── History tables ── */
    .history-block {
      background: white;
      border-radius: 10px;
      padding: 1.2rem 1.4rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }

    .history-block h2 {
      font-size: 1rem;
      font-weight: 700;
      margin-bottom: 0.9rem;
      color: #1a1a2e;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }

    th {
      text-align: left;
      padding: 0.5rem 0.6rem;
      background: #f8fafc;
      color: #666;
      font-weight: 600;
      border-bottom: 1.5px solid #e5e7eb;
    }

    td {
      padding: 0.5rem 0.6rem;
      border-bottom: 1px solid #f1f5f9;
      vertical-align: top;
    }

    .row-fail td { background: #fff8f8; }

    .error-cell {
      color: #ef4444;
      font-size: 0.75rem;
      max-width: 200px;
      word-break: break-word;
    }

    /* ── Badges ── */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 20px;
      font-size: 0.72rem;
      font-weight: 700;
      white-space: nowrap;
    }

    .badge-ok      { background: #dcfce7; color: #16a34a; }
    .badge-fail    { background: #fee2e2; color: #dc2626; }
    .badge-unknown { background: #f3f4f6; color: #9ca3af; }

    .hint { font-size: 0.8rem; color: #aaa; margin-top: 0.3rem; }

    @media (max-width: 500px) {
      body { padding: 1rem; }
      .cards { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1><span class="logo">CF</span> WP Cron Dashboard</h1>
    <span class="meta">Updated: ${now}</span>
  </header>

  <nav>
    <a href="?kv=status"  class="${type === "status"  ? "active" : ""}">Current Status</a>
    <a href="?kv=history" class="${type === "history" ? "active" : ""}">Run History</a>
  </nav>

  ${type === "status" ? `<div class="cards">${body}</div>` : body}
</body>
</html>`;
}


// ─── HTTP dashboard handler ───────────────────────────────────────────────────

/**
 * Dashboard served over HTTP.
 * - Browsers (Accept: text/html) → styled HTML page
 * - Everything else (curl, API) → raw JSON
 *
 * Query params:
 *   ?kv=status            → latest run for all sites
 *   ?kv=history           → last 10 runs for all sites
 *   ?kv=status&site=x.com → latest run for one site only
 *   ?kv=history&site=x.com
 */
async function handleDashboard(request, env, sites) {
  const url = new URL(request.url);
  const type = url.searchParams.get("kv");
  const siteFilter = url.searchParams.get("site");

  if (!["status", "history"].includes(type)) {
    return new Response(
      JSON.stringify({ error: 'Use ?kv=status or ?kv=history' }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!env.WP_CRON_KV) {
    return new Response(
      JSON.stringify({ error: "KV binding WP_CRON_KV is not configured." }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  let data;

  if (siteFilter) {
    const value = await env.WP_CRON_KV.get(`${type}:${siteFilter}`);
    data = { [siteFilter]: value ? JSON.parse(value) : null };
  } else {
    data = await readAllKV(env.WP_CRON_KV, sites, type);
  }

  // Return HTML for browsers, JSON for everything else
  if (isBrowser(request)) {
    return new Response(renderHTML(type, data), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}


// ─── Worker entry points ──────────────────────────────────────────────────────

export default {

  /**
   * scheduled() — fired by Cloudflare Cron Trigger on your chosen schedule.
   * This is the primary, automated execution path.
   * event.scheduledTime is passed through so the KV throttle gate can use
   * it for deterministic, wall-clock-aligned write decisions.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env, event.scheduledTime));
  },

  /**
   * fetch() — fired when the Worker URL is accessed over HTTP.
   * Used for the read-only KV dashboard (?kv=status / ?kv=history).
   * All other paths return a plain JSON status message.
   * Cloudflare requires a fetch handler to be present even on cron-only Workers;
   * without it, visiting the Worker URL produces a runtime error instead of a
   * clean response.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // KV dashboard
    if (url.searchParams.has("kv")) {
      let sites = [];
      try { sites = parseSites(env); } catch { /* empty sites list is fine here */ }
      return handleDashboard(request, env, sites);
    }

    // Default: plain status page
    return new Response(
      JSON.stringify({
        worker: "CF WP Cron",
        status: "active",
        tip: "Add ?kv=status or ?kv=history to read KV data.",
        time: new Date().toISOString(),
      }, null, 2),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  },
};
