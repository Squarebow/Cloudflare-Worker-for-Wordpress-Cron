# Cloudflare Worker for WordPress Cron
### Single-Site Version (switch branch to multi-site for multi-site version)

Trigger `wp-cron.php` for one WordPress site reliably from Cloudflare's network, replacing WordPress's built-in scheduler. Switch between main and multi-site branch for the version that suits you best.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![WordPress](https://img.shields.io/badge/WordPress-Cron-21759B?logo=wordpress&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Version](https://img.shields.io/badge/Version-Single--Site-blue)

---

## Table of Contents

- [Overview](#overview)
- [Single-Site vs Multi-Site: which version do I need?](#single-site-vs-multi-site-which-version-do-i-need)
- [Why offload WordPress cron to a Worker?](#why-offload-wordpress-cron-to-a-worker)
- [Performance and server load](#performance-and-server-load)
- [How it works](#how-it-works)
- [Setup](#setup)
- [Securing wp-cron.php on your server](#securing-wp-cronphp-on-your-server)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Notes and limitations](#notes-and-limitations)

---

## Overview

WordPress has a built-in task scheduler called **WP-Cron**. By default it runs on every page load, which wastes server resources and is unreliable on low-traffic sites. The standard solution is to disable the built-in scheduler and trigger `wp-cron.php` from an external source on a fixed schedule.

This Worker does exactly that. It runs on Cloudflare's network on a timed schedule (a **Cron Trigger**), sends an authenticated HTTP GET request to `wp-cron.php` on your site, and logs the result — all without touching your web server's own cron daemon.

---

## Single-Site vs Multi-Site: which version do I need?

| | Single-Site (this version) | Multi-Site |
|---|---|---|
| **Number of WordPress sites** | One | Two or more |
| **Configuration** | Two environment variables (`WP_CRON_URL`, `WP_CRON_KEY`) | One JSON array (`WP_CRON_SITES`) with a `url` and `key` per site |
| **Requires a Worker Route** | Yes — bound to `your-site.com/wp-cron.php*` | No |
| **Browser test** | Visit `https://your-site.com/wp-cron.php` — the Worker responds directly | Not applicable |
| **Good for** | A single blog or application | Agencies, developers, or anyone managing multiple sites |

---

## Why offload WordPress cron to a Worker?

- **Reliability.** WP-Cron only runs when someone visits your site. Low-traffic sites may miss scheduled tasks entirely.
- **Performance.** Every WP-Cron check adds overhead to real page loads. Disabling it removes that overhead.
- **No server cron needed.** You don't need SSH access or the ability to edit the server's crontab.
- **Free.** Cloudflare Workers are free up to 100,000 requests per day.

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

---

### Where the gain is most felt

**Low-traffic sites** gain reliability above all else. WP-Cron may never fire at all if no visitors arrive during off-hours. The Worker runs on a fixed schedule regardless.

**Medium-traffic sites** (1k–20k visits/day) see a measurable reduction in PHP-FPM worker consumption, which on shared or entry-level VPS hosting often means staying within resource limits instead of hitting them.

**High-traffic sites** benefit most from eliminating loopback storms. Under sudden traffic spikes, the default WP-Cron behaviour can spawn large numbers of concurrent self-requests. Disabling it removes that risk entirely.

### In short

You replace up to tens of thousands of daily server self-requests — each a full PHP and WordPress bootstrap — with exactly **1,440 lightweight requests per day** from Cloudflare's network, cleanly separated from real visitor traffic and costing your server nothing to initiate.


## How it works

The Worker has two handlers that share the same core logic:

**`scheduled()` — the automated path.** Cloudflare calls this on your chosen schedule (e.g. every minute). The Worker sends an HTTP GET request to `https://your-site.com/wp-cron.php?doing_wp_cron` with a secret `X-Worker-Auth` header. If WordPress returns HTTP 200, the run is logged as a success.

**`fetch()` — the manual/test path.** The Worker is also bound to a Route on your domain (`your-site.com/wp-cron.php*`). When you visit that URL in a browser, the `fetch()` handler fires the same cron request and returns a confirmation message directly:

```
Cloudflare Worker for WordPress works. Yay!
```

Any other URL on your site (normal pages, images, etc.) passes straight through to your origin server — the Worker does not interfere.

---

## Setup

### 1. Create the Worker

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. Go to **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name (e.g. `wp-cron`) and click **Deploy**.
4. Click **Edit code**, replace the default code with the contents of `worker.js`, and click **Deploy** again.

### 2. Add environment variables

Go to your Worker → **Settings** → **Variables and Secrets** and add:

| Name | Type | Value |
|------|------|-------|
| `WP_CRON_URL` | Plain text | Full base URL of your site, e.g. `https://example.com` |
| `WP_CRON_KEY` | **Secret** | A long, random string — treat it like a password |

> `WP_CRON_KEY` must be **Secret** (not Plain text). Secrets are encrypted at rest and are not visible in the dashboard after saving.

### 3. Add a Worker Route

The Route is what connects this Worker to your domain so the `fetch()` handler can intercept browser visits to `/wp-cron.php` and return the confirmation message.

1. In the Cloudflare dashboard, go to **Websites** → select your domain → **Workers Routes** → **Add Route**.
2. Set the route pattern to:
   ```
   your-site.com/wp-cron.php*
   ```
3. Select this Worker from the dropdown and save.

> The `*` wildcard at the end ensures the route matches `wp-cron.php?doing_wp_cron` and any other query string.

### 4. Add a WAF skip rule (if your site uses Cloudflare WAF)

If your domain is proxied through Cloudflare and you have WAF (Web Application Firewall) rules enabled, the cron request from the Worker may be blocked before it reaches your server. Add a skip rule to allow it through.

1. Go to **Security** → **WAF** → **Custom Rules** → **Create rule**.
2. Set the match expression to:
   ```
   (http.request.uri.path eq "/wp-cron.php" and http.request.headers["x-worker-auth"] ne "")
   ```
3. Set **Action** to **Skip** → **All remaining custom rules**.
4. Enable logging and save.
5. Place this rule **above** any existing rules that block `wp-cron.php`.

> If you are not using Cloudflare WAF, skip this step.

### 5. Add a Cron Trigger

1. In your Worker, go to **Settings** → **Triggers** → **Cron Triggers** → **Add Cron Trigger**.
2. Enter the cron expression for every minute (the minimum Cloudflare allows):
   ```
   * * * * *
   ```

> All Cloudflare Cron Triggers run in UTC.

### 6. Disable WP-Cron on your WordPress site

Add the following line to `wp-config.php`, **before** the line that says `/* That's all, stop editing! */`:

```php
define( 'DISABLE_WP_CRON', true );
```

This tells WordPress not to run its built-in scheduler on page loads. The Worker now owns that responsibility entirely.

### 7. Test

Visit this URL in your browser:

```
https://your-site.com/wp-cron.php
```

You should see:

```
Cloudflare Worker for WordPress works. Yay!
```

This confirms the Worker Route is active, the Worker can reach your site, and WordPress returned HTTP 200. The Worker itself generates this message — no changes to WordPress are needed.

If you see your normal site instead of the message, the Worker Route is not active yet. Check that the route pattern is correct and that the Worker is deployed.

### 8. Monitor

Go to your Worker → **Observability** → **Logs** to see a log line for every cron run.  
Go to **Triggers** → **Cron Triggers** → **Past Events** for a history of the last 100 invocations.

---

## Securing wp-cron.php on your server

Once `DISABLE_WP_CRON` is set, `wp-cron.php` should only respond to requests from this Worker. Block all other access using the `X-Worker-Auth` header as the gate.

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
    # Continue to your normal PHP handler:
    include fastcgi_params;
    fastcgi_pass php-handler;
}
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Browser shows your normal site instead of the confirmation | Worker Route not active | Check the route pattern in **Websites → Workers Routes** |
| `Missing environment variable` message in browser | `WP_CRON_URL` or `WP_CRON_KEY` not set | Add both variables in Worker **Settings → Variables and Secrets** |
| HTTP 403 from your server | WAF or server rule blocking the request | Add or check the WAF skip rule (Step 4) |
| HTTP 404 | `wp-cron.php` not found or blocked at server level | Confirm the file exists and is accessible |
| HTTP 5xx from your server | WordPress or PHP error | Check the WordPress error log on the server |
| Timeout in Worker logs | Site is too slow to respond | Check server load; the Worker times out after 10 seconds |
| Cron jobs still not running | `DISABLE_WP_CRON` not set, or set in the wrong place | Confirm `define( 'DISABLE_WP_CRON', true )` is in `wp-config.php` before the stop-editing comment |
| `1101` Worker error | JavaScript exception in the Worker | Open Worker **Observability → Logs** for the full error |

---

## Notes and limitations

- **Cron Triggers run in UTC.** Factor this in if your scheduled WordPress tasks are time-sensitive.
- **Minimum trigger interval is 1 minute.** This matches WordPress's own scheduler resolution.
- **There is a limit of 3 Cron Trigger schedules per Worker.** You can combine expressions if needed.
- **The `fetch()` handler only intercepts `/wp-cron.php`.** All other paths on your domain pass through to your origin without modification.
- **This version handles one site.** For multiple independent WordPress sites, use the Multi-Site version instead.
