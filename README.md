# Cloudflare Worker for WordPress Cron

Trigger `wp-cron.php` for one or more WordPress sites from a single Cloudflare Worker, with per-site authentication, KV status tracking, and a built-in monitoring dashboard. Made for Cloudflare FREE tier with no dependency on the target site's hosting provider or infrastructure.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![WordPress](https://img.shields.io/badge/WordPress-Cron-21759B?logo=wordpress&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Version](https://img.shields.io/badge/Version-3.0.0-blue)

---

## Table of Contents

- [Overview](#overview)
- [Why offload WordPress cron to a Worker?](#why-offload-wordpress-cron-to-a-worker)
- [Performance and server load](#performance-and-server-load)
- [Hosting compatibility](#hosting-compatibility)
- [How it works](#how-it-works)
- [Setup](#setup)
- [Securing wp-cron.php on your server](#securing-wp-cronphp-on-your-server)
- [Testing](#testing)
- [KV status tracking (optional)](#kv-status-tracking-optional)
- [Troubleshooting](#troubleshooting)
- [Notes and limitations](#notes-and-limitations)

---

## Overview

WordPress has a built-in task scheduler called **WP-Cron**. By default it runs on every page load, which wastes server resources and is unreliable on low-traffic sites. The standard solution is to disable the built-in scheduler and trigger `wp-cron.php` from an external source on a fixed schedule.

This Worker does exactly that. It runs on Cloudflare's network on a timed schedule (a **Cron Trigger**), loops through your list of WordPress sites, and sends an authenticated HTTP request to `wp-cron.php` on each one — all without touching your web server's own cron daemon.

It works equally well for a single site or many. You configure a JSON array with one entry or twenty; the Worker handles both identically.

> **Note:** "Multiple sites" here means multiple independent WordPress installations. This is **not** related to [WordPress Multisite](https://wordpress.org/documentation/article/create-a-network/) (WordPress's built-in network feature for running sub-sites under one installation).

---

## Why offload WordPress cron to a Worker?

- **Reliability.** WP-Cron only runs when someone visits your site. Low-traffic sites may miss scheduled tasks entirely.
- **Performance.** Every WP-Cron check adds overhead to real page loads. Disabling it removes that overhead.
- **No server cron needed.** You don't need SSH access or the ability to edit the server's crontab.
- **Centralised.** One Worker handles all your sites. You manage the schedule in one place.

---

## Performance and server load

Offloading WordPress cron to a Cloudflare Worker eliminates an entire category of server overhead that most site owners are not aware of.

### How WP-Cron works by default

Every page request to a WordPress site triggers a call to `spawn_cron()`, which fires a loopback HTTP request — the server calling itself — to run `wp-cron.php`. That self-request is a full WordPress boot: loading all plugins, connecting to the database, parsing configuration. It typically costs **50–200ms of CPU time and 20–60MB of RAM** per invocation. Under traffic spikes, dozens of these can stack up simultaneously, each competing for a PHP-FPM slot and a database connection.

### What setting `DISABLE_WP_CRON = true` removes

| What disappears | What it was costing |
|---|---|
| `spawn_cron()` check on every page load | PHP overhead on every single request |
| Loopback HTTP request to self | Full TCP connection + complete WordPress bootstrap per trigger |
| Cron pile-ups under traffic spikes | Multiple overlapping PHP processes competing for DB connections |

### Requests saved by traffic level

| Daily visits | Loopback attempts eliminated | Actual cron executions |
|---|---|---|
| 500 | ~500 per day | ~1,440 clean Worker requests |
| 5,000 | ~5,000 per day | ~1,440 clean Worker requests |
| 50,000 | ~50,000 per day | ~1,440 clean Worker requests |

Regardless of traffic, WordPress cron only needs to run approximately once per minute. The Worker does exactly that — 1,440 times per day — replacing an unpredictable number of server self-requests with a fixed, predictable load entirely separate from visitor traffic.

### Where the gain is most felt

**Low-traffic sites** gain reliability above all else. WP-Cron may never fire at all if no visitors arrive during off-hours. The Worker runs on a fixed schedule regardless.

**Medium-traffic sites** (1k–20k visits/day) see a measurable reduction in PHP-FPM worker consumption, which on shared or entry-level VPS hosting often means staying within resource limits instead of hitting them.

**High-traffic sites** benefit most from eliminating loopback storms. Under sudden traffic spikes, the default WP-Cron behaviour can spawn large numbers of concurrent self-requests. Disabling it removes that risk entirely.

### In short

You replace up to tens of thousands of daily server self-requests — each a full PHP and WordPress bootstrap — with exactly **1,440 lightweight requests per day** from Cloudflare's network, cleanly separated from real visitor traffic and costing your server nothing to initiate.

---

## Hosting compatibility

Any publicly reachable WordPress site can be added to the `WP_CRON_SITES` array,
regardless of where it is hosted. The Worker makes a standard HTTP GET request to
`/wp-cron.php` on each site — it has no dependency on the target site's hosting
provider or infrastructure.

This means the following all work without any special configuration:

- Sites hosted on **shared hosting** (no SSH or crontab access needed)
- Sites on **managed WordPress hosting** (WP Engine, Kinsta, Flywheel, etc.)
- Sites on a **VPS or dedicated server**
- Sites behind **Cloudflare's proxy** (orange cloud on or off)
- Sites on hosting providers with **no Cloudflare connection at all**
- Sites on **different servers, different countries, different providers** — all
  managed by a single Worker instance

The only hard requirements are:

1. The site must be **publicly reachable** over HTTPS
2. The `/wp-cron.php` endpoint must **not be blocked** by a firewall, WAF rule,
   or IP allowlist that would reject Cloudflare's outbound IP ranges
3. The site must be running **WordPress** — the URL receives a standard WP-Cron
   HTTP request, so non-WordPress URLs will return errors (logged in KV as failed
   runs, but will not affect the other sites in the list)

---

## How it works

The Worker reads the environment variable `WP_CRON_SITES`, which holds a JSON array. Each entry in the array has two fields:

| Field | Description                                   | Example                    |
|-------|-----------------------------------------------|----------------------------|
| `url` | Full base URL of the WordPress site           | `https://example.com`      |
| `key` | Secret string sent in the `X-Worker-Auth` header | `my-secret-key-123`    |

On every scheduled run, the Worker fires an HTTP GET request to `{url}/wp-cron.php?doing_wp_cron` for each site in parallel. The request includes an `X-Worker-Auth` header so your server can verify the call is genuine and reject any direct access.

All requests run in **parallel** (not one after another), so the total time is roughly equal to the slowest single site, regardless of how many sites you have.

## Cloudflare free tier usage

Every cron trigger fire counts as **1 Worker request**, regardless of how many sites are in your list. The sites inside are **subrequests**, counted separately and not subject to the same daily cap.

With `* * * * *` (every minute) and 3 sites configured:

| What | Daily count |
|---|---|
| Worker requests (cron fires) | 1,440 |
| Subrequests (site calls) | 4,320 |

Cloudflare's free tier allows **100,000 Worker requests per day** — you would need to manage roughly 70 sites before approaching that limit. Adding more sites to your JSON array costs nothing extra in terms of free tier quota.

---

## Setup

### 1. Create the Worker

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. Go to **Compute** → **Workers & Pages** → **Create application** → **Start with Hello World!**
3. Give the Worker a name (e.g. `wp-cron`) and click **Deploy**.
4. Click **Edit code** and replace the default code with the contents of `worker.js`.
5. Click **Deploy** again to save.

### 2. Add the environment variable

1. In your Worker, go to **Settings** → **Variables and Secrets** → **+Add**.
2. Add a new variable named `WP_CRON_SITES`. Two binding types work:

| Type | Behaviour |
|------|-----------|
| **Secret** | Cloudflare stores and displays the value as masked. The Worker receives a raw string and parses it as JSON internally. |
| **JSON** | Cloudflare parses the value automatically and passes a ready JavaScript array to the Worker. The value is visible in the Dashboard bindings panel. |

Both types are fully supported. **Secret is recommended** because your JSON contains authentication keys — masking them in the Dashboard reduces the risk of accidental exposure.

> **Tip:** If you accidentally add the variable as the wrong type and the Worker logs a JSON parse error, simply delete the binding and re-add it with the correct type. No other changes are needed.

**Format for a single site:**
```json
[
  { "url": "https://mysite.com", "key": "a-strong-secret" }
]
```

**Format for multiple sites:**
```json
[
  { "url": "https://site1.com", "key": "a-strong-secret-1" },
  { "url": "https://site2.net", "key": "a-strong-secret-2" },
  { "url": "https://blog.site3.org", "key": "a-strong-secret-3" }
]
```

The field order within each object (`url` first or `key` first) does not matter — the Worker reads both fields by name.

Each `url` must include the scheme (`https://`) and must not have a trailing slash. Each `key` should be a unique, hard-to-guess string — treat it like a password.

**To add a site later**, edit the JSON and add a new `{ "url": "...", "key": "..." }` object to the array.

### 3. Add a Cron Trigger

1. In your Worker, go to **Settings** → **Trigger Events** → **+Add** → **Cron Triggers**.
2. Enter a schedule or cron expression. One minute is the minimum interval Cloudflare allows:

```
* * * * *
```

> Cloudflare uses UTC for all cron schedules.

### 4. Enable workers Logs

In your Worker, go to **Observability** → **click Pencil icon to edit** → **Enable Workers Logs**. Set Head-based sampling rate to 100, tick Include invocation logs, enable Persist logs to the Workers dashboard and deploy.

### 5. Disable WP-Cron on each WordPress site

Add the following line to each site's `wp-config.php`, **before** the line that says `/* That's all, stop editing! */`:

```php
define( 'DISABLE_WP_CRON', true );
```

This tells WordPress not to run its built-in scheduler on page loads. The Worker now takes over that responsibility entirely.

---

## Securing wp-cron.php on your server

Once `DISABLE_WP_CRON` is set, `wp-cron.php` only needs to respond to requests from this Worker. You should block all other access to it. The examples below use the `X-Worker-Auth` header as the gate.

### Apache (2.4+)

```apache
<Files "wp-cron.php">
    Require all denied
    <RequireAny>
        Require env worker_auth
    </RequireAny>
</Files>

SetEnvIfNoCase X-Worker-Auth ".+" worker_auth
```

### Nginx

```nginx
location = /wp-cron.php {
    if ($http_x_worker_auth = "") {
        return 403;
    }
    # Continue to your normal PHP handler, e.g.:
    include fastcgi_params;
    fastcgi_pass php-handler;
}
```

> **Tip:** For stronger protection, you can also verify the value of `X-Worker-Auth` matches the expected key, not just that the header is present. This can be done in a WordPress `mu-plugin` or at the server level.

---

## Testing

### Check the Worker runs at all

Use [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare's CLI tool) to trigger the scheduled handler locally:

```bash
npx wrangler dev --test-scheduled
# Then in another terminal:
curl "http://localhost:8787/__scheduled"
```

### Check a specific site is reachable

Open this URL in a browser (replacing the domain with your own):

```
https://your-site.com/wp-cron.php?doing_wp_cron
```

If WordPress is installed correctly you should get a blank or very short response with HTTP 200. A 404 means the file is missing or blocked.

### View live Worker logs

In the Cloudflare dashboard, go to your Worker → **Observability**. You will events, invocations, traces and visualizations. Under Worker → **Metrics** you will see aggregated data of deployments in selected time slots.

### Check past runs

Go to your Worker → **Trigger Events** → **View Events** to see a history of the last 100 invocations and their status.

---

## KV status tracking (optional but highly recommended)

The Worker can log the result of every cron run to a
[Cloudflare KV namespace](https://developers.cloudflare.com/kv/). This gives
you a lightweight audit trail without any external monitoring service. It works
the same whether you have one site or many — each site gets its own entry in KV,
keyed by hostname.

### What gets stored

For each site, two keys are maintained:

| KV key | Contents |
|---|---|
| `status:<hostname>` | Latest run only — always overwritten |
| `history:<hostname>` | Last 10 runs, newest first |

Each entry records the site URL, HTTP status code, success flag, start and
finish timestamps, a preview of the response body, and any error message.
Entries expire automatically after 48 hours.

### Setup

1. Go to **Storage & databases → Workers KV** → click **Create instance**.
   Name it anything (e.g. `wp-cron-status`) and save.
2. Open your Worker → **Compute → Workers & Pages → Overview** → click **+ Binding → Overview** → select **KV namespace** and click **Add Binding**
3. Set the variable name to `WP_CRON_KV` and select the namespace you just
   created. Click **Add Binding**, then redeploy the Worker.

### Reading the data

After the first scheduled cron run you can inspect the stored data in two ways:

1. **Cloudflare Dashboard** — Storage & databases → Workers KV → select your namespace →
KV Pairs tab. Search by prefix `status:` or `history:` and click view.

2. **Worker URL Custom Dashboard (Recommended)** — append a query parameter to your Worker's URL:
Open your Worker → **Compute → Workers & Pages → Overview** → click **Visit** icon in top right corner. A new browser tab will open displaying JSON raw format, something like:
`{
  "worker": "CF WP Cron",
  "status": "active",
  "tip": "Add ?kv=status or ?kv=history to read KV data.",
  "time": "2026-03-05T11:25:30.547Z"
}`

Now, append one of the two available query parameters from the tip to the end of the URL: `/?kv=status` or `/?kv=history`

```
# Latest run for all sites
https://your-worker.workers.dev/?kv=status

# Last 10 runs for all sites
https://your-worker.workers.dev/?kv=history

# Filter to a single site
https://your-worker.workers.dev/?kv=status&site=example.com
https://your-worker.workers.dev/?kv=history&site=example.com
```

Visiting these URLs in a browser renders a styled HTML dashboard. Accessing them via `curl` or any API client returns raw JSON.

> **Note:** KV is fully optional. If the binding is not added, the Worker
> operates exactly as before — no errors, no changed behaviour.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Failed to parse WP_CRON_SITES: Unexpected token 'o', "[object Obj"... is not valid JSON` | `WP_CRON_SITES` was added as a **JSON** binding type instead of a **Secret** | Re-add the variable as type **Secret** with the raw JSON string as its value |
| `WP_CRON_SITES` parse error in logs | Invalid JSON in the variable | Validate your JSON at [jsonlint.com](https://jsonlint.com) before saving |
| HTTP 403 for a site | Server is blocking the request | Check your `X-Worker-Auth` header rules on that server |
| HTTP 404 for a site | `wp-cron.php` not found or blocked | Confirm the file exists and is not blocked by a firewall rule |
| HTTP 5xx for a site | WordPress or PHP error | Check that site's WordPress error log |
| Timeout in logs | Site is too slow to respond | Check server load; the Worker times out after 25 seconds per site |
| Cron jobs still not running | `DISABLE_WP_CRON` not set | Confirm `define( 'DISABLE_WP_CRON', true )` is in `wp-config.php` |
| Worker trigger `1101` error | JavaScript exception | Open Worker logs to see the full error message |

---

## Notes and limitations

- **Cron Triggers execute in UTC.** Factor this in if your scheduled WordPress tasks are time-sensitive.
- **Minimum trigger interval is 1 minute.** WordPress's built-in scheduler also uses minute-level resolution, so this matches the expected behaviour.
- **There is a limit of 3 Cron Trigger schedules per Worker.** You can combine multiple expressions if needed (e.g. one every minute, one every hour).
- **All sites run in parallel.** If one site is slow or unreachable, it does not delay the others. Each site has a 25-second timeout.
- **Cron Trigger history shows the last 100 runs.** For longer retention, enable [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/) in the dashboard.
- **Visiting the Worker URL directly returns a JSON status message.** The Worker's `fetch` handler responds with a plain JSON object confirming the Worker is active, and directs you to the `?kv=` dashboard endpoints. Cloudflare requires a `fetch` handler to be present on all Workers; without it, visiting the Worker URL would produce a runtime error instead of a clean response.
