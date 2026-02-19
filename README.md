# Cloudflare Worker for WordPress Cron
### Multi-Site Version

Trigger `wp-cron.php` for any number of independent WordPress sites from a single Cloudflare Worker, with a separate secret key per site. Switch between main and multi-site branch for the version that suits you.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![WordPress](https://img.shields.io/badge/WordPress-Cron-21759B?logo=wordpress&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Version](https://img.shields.io/badge/Version-Multi--Site-purple)

---

## Table of Contents

- [Overview](#overview)
- [Single-Site vs Multi-Site: which version do I need?](#single-site-vs-multi-site-which-version-do-i-need)
- [Why offload WordPress cron to a Worker?](#why-offload-wordpress-cron-to-a-worker)
- [How it works](#how-it-works)
- [Setup](#setup)
- [Securing wp-cron.php on your server](#securing-wp-cronphp-on-your-server)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Notes and limitations](#notes-and-limitations)

---

## Overview

WordPress has a built-in task scheduler called **WP-Cron**. By default it runs on every page load, which wastes server resources and is unreliable on low-traffic sites. The standard solution is to disable the built-in scheduler and trigger `wp-cron.php` from an external source on a fixed schedule.

This Worker does exactly that. It runs on Cloudflare's network on a timed schedule (a **Cron Trigger**), loops through your list of WordPress sites, and sends an authenticated HTTP request to `wp-cron.php` on each one — all without touching your web server's own cron daemon.

---

## Single-Site vs Multi-Site: which version do I need?

| | Single-Site | Multi-Site (this version) |
|---|---|---|
| **Number of WordPress sites** | One | Two or more |
| **Configuration** | Two separate environment variables (`WP_CRON_URL`, `WP_CRON_KEY`) | One JSON array (`WP_CRON_SITES`) with a `url` and `key` per site |
| **Worker instances needed** | One per site | One for all sites |
| **Good for** | A single blog or application | Agencies, developers, or anyone managing multiple sites |

> **Note:** "Multi-Site" here means multiple independent WordPress installations. This is **not** related to [WordPress Multisite](https://wordpress.org/documentation/article/create-a-network/) (WordPress's built-in network feature for running sub-sites under one installation).

---

## Why offload WordPress cron to a Worker?

- **Reliability.** WP-Cron only runs when someone visits your site. Low-traffic sites may miss scheduled tasks entirely.
- **Performance.** Every WP-Cron check adds overhead to real page loads. Disabling it removes that overhead.
- **No server cron needed.** You don't need SSH access or the ability to edit the server's crontab.
- **Centralised.** One Worker handles all your sites. You manage the schedule in one place.

---

## How it works

The Worker reads the environment variable `WP_CRON_SITES`, which holds a JSON array. Each entry in the array has two fields:

| Field | Description                                   | Example                    |
|-------|-----------------------------------------------|----------------------------|
| `url` | Full base URL of the WordPress site           | `https://example.com`      |
| `key` | Secret string sent in the `X-Worker-Auth` header | `my-secret-key-123`    |

On every scheduled run, the Worker fires an HTTP GET request to `{url}/wp-cron.php?doing_wp_cron` for each site in parallel. The request includes a `X-Worker-Auth` header so your server can verify the call is genuine and reject any direct access.

All requests run in **parallel** (not one after another), so the total time is roughly equal to the slowest single site, regardless of how many sites you have.

---

## Setup

### 1. Create the Worker

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. Go to **Workers & Pages** → **Create** → **Create Worker**.
3. Give the Worker a name (e.g. `wp-cron`) and click **Deploy**.
4. Click **Edit code** and replace the default code with the contents of `worker.js`.
5. Click **Deploy** again to save.

### 2. Add the environment variable

1. In your Worker, go to **Settings** → **Variables and Secrets**.
2. Add a new variable:

| Name | Type | Value |
|------|------|-------|
| `WP_CRON_SITES` | **Secret** | Your JSON array (see format below) |

> Use **Secret** (not Plain text) because the value contains your site keys. Secrets are encrypted at rest and are not visible in the dashboard after saving.

#### WP_CRON_SITES format

```json
[
  { "url": "https://site1.com",      "key": "a-strong-secret-1" },
  { "url": "https://site2.net",      "key": "a-strong-secret-2" },
  { "url": "https://blog.site3.org", "key": "a-strong-secret-3" }
]
```

Each `url` must include the scheme (`https://`) and must not have a trailing slash. Each `key` should be a unique, hard-to-guess string — treat it like a password.

**To add a site later**, edit the JSON and add a new `{ "url": "...", "key": "..." }` object to the array.

### 3. Add a Cron Trigger

1. In your Worker, go to **Settings** → **Triggers** → **Cron Triggers** → **Add Cron Trigger**.
2. Enter a cron expression. One minute is the minimum interval Cloudflare allows:

```
* * * * *
```

> Cloudflare uses UTC for all cron schedules.

### 4. Disable WP-Cron on each WordPress site

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

In the Cloudflare dashboard, go to your Worker → **Observability** → **Logs**. You will see a log line per site on every run, confirming success or showing the error.

### Check past runs

Go to your Worker → **Triggers** → **Cron Triggers** → **Past Events** to see a history of the last 100 invocations and their status.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `WP_CRON_SITES` parse error in logs | Invalid JSON in the variable | Validate your JSON at [jsonlint.com](https://jsonlint.com) before saving |
| HTTP 403 for a site | Server is blocking the request | Check your `X-Worker-Auth` header rules on that server |
| HTTP 404 for a site | `wp-cron.php` not found or blocked | Confirm the file exists and is not blocked by a firewall rule |
| HTTP 5xx for a site | WordPress or PHP error | Check that site's WordPress error log |
| Timeout in logs | Site is too slow to respond | Check server load; the Worker times out after 10 seconds per site |
| Cron jobs still not running | `DISABLE_WP_CRON` not set | Confirm `define( 'DISABLE_WP_CRON', true )` is in `wp-config.php` |
| Worker trigger `1101` error | JavaScript exception | Open Worker logs to see the full error message |

---

## Notes and limitations

- **Cron Triggers execute in UTC.** Factor this in if your scheduled WordPress tasks are time-sensitive.
- **Minimum trigger interval is 1 minute.** WordPress's built-in scheduler also uses minute-level resolution, so this matches the expected behaviour.
- **There is a limit of 3 Cron Trigger schedules per Worker.** You can combine multiple expressions if needed (e.g. one every minute, one every hour).
- **All sites run in parallel.** If one site is slow or unreachable, it does not delay the others. Each site has a 10-second timeout.
- **Cron Trigger history shows the last 100 runs.** For longer retention, enable [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/) in the dashboard.
- **This Worker has no `fetch` handler.** It only responds to scheduled triggers. If you open the Worker URL in a browser, Cloudflare will return a default error — this is expected behaviour.
