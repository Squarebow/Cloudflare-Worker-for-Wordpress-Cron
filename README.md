# Cloudflare Worker for Wordpress wp-cron.php

A simple serverless script to offload wp-cron.php to your free Cloudflare account. Because every request counts ;)

## Key Features:

✅ Proper Cloudflare Cron Trigger Handling – Uses export default to ensure compatibility with Cloudflare’s scheduled event.
✅ Error Handling & Logging – Logs execution times, HTTP response failures, and errors.
✅ Ensures Fresh Request – Avoids caching issues with Cache-Control and cf.cacheTtl.
✅ Security Considerations – You can store the cron URL in Cloudflare Worker Secrets instead of hardcoding it.

Moving WordPress system cron jobs (WP-Cron) from the hosting server to a Cloudflare Worker can offer several benefits in terms of resources and performance:

### 1. Reduced Server Load

WP-Cron runs on every page visit, triggering scheduled tasks, which can cause high CPU and memory usage, especially on high-traffic websites.

Moving WP-Cron to a Cloudflare Worker ensures tasks run independently, freeing up server resources.

### 2. More Reliable Execution

WP-Cron relies on visitor traffic, meaning scheduled tasks may be delayed if there are no visits.

Cloudflare Workers can trigger cron jobs at precise intervals, ensuring reliability.

### 3. Faster Page Load Times

Since WP-Cron runs in the background when users visit a page, it can slow down load times.

Offloading it to Cloudflare means WordPress requests are lighter, improving performance.

### 4. Scalability

Hosting providers may limit CPU usage for frequent cron jobs, impacting large sites.

Cloudflare’s edge network scales easily without overloading the origin server.

### 5. Improved Security

Running WP-Cron externally reduces potential attack vectors, such as DDoS attacks exploiting heavy cron executions.

Cloudflare adds an extra layer of security before requests hit the server. And gives users generous 100.000 requests/day - for free. [More](https://developers.cloudflare.com/workers/platform/limits/)

### How to Implement It

Disable WP-Cron in WordPress
Add this to wp-config.php:

``define('DISABLE_WP_CRON', true);``

Set Up a Cloudflare Worker

Use JavaScript to make scheduled requests to wp-cron.php at specific intervals.
