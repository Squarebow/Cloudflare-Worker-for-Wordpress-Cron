/* 
  Cloudflare Worker - MAIN flavor
  --------------------------------
  Purpose: trigger WordPress cron by proxying/handling requests to /wp-cron.php
  This file is your *existing* working script with extensive inline comments.
  NO functional changes were made — only comments added for clarity/maintenance.
*/

export default {
  // HTTP fetch handler: this allows the Worker to be attached to a route
  // (your current setup uses a route like spletni.navticni-tecaji.si/wp-cron.php*).
  // When a normal HTTP request arrives, this fetch() runs.
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // If the incoming HTTP request path is exactly "/wp-cron.php",
    // we call handleScheduled() (this mirrors what happens on scheduled events).
    // NOTE: returning handleScheduled() result here allows you to test by
    // visiting https://your-domain/wp-cron.php in a browser.
    if (url.pathname === "/wp-cron.php") {
      // Pass the configured DEFAULT_DOMAIN and WORKER_SECRET_KEY from env
      return handleScheduled(env.DEFAULT_DOMAIN, env.WORKER_SECRET_KEY);
    }

    // For every other request path (normal site pages), allow it to pass
    // through Cloudflare to your origin unchanged.
    return fetch(req);
  },

  // scheduled() handler: invoked only by Cloudflare Cron Triggers (no route needed)
  // Your Cloudflare trigger calls this on the schedule you configured (*/1 * * * *).
  async scheduled(event, env, ctx) {
    // Log the scheduled time for observability in Cloudflare Logs
    console.log(`Cron triggered at: ${new Date(event.scheduledTime).toISOString()}`);

    // Use ctx.waitUntil to run the cron trigger in the background (non-blocking)
    // so the scheduled event returns immediately while the fetch runs asynchronously.
    ctx.waitUntil(handleScheduled(env.DEFAULT_DOMAIN, env.WORKER_SECRET_KEY));
  },
};

// Core worker function that triggers the WordPress cron endpoint.
// Note: the function returns an HTTP Response when called from fetch()
// (so browser testing returns a status message), and when called via
// scheduled() ctx.waitUntil we don't use the response, but it's still useful
// for consistent logging and error handling.
async function handleScheduled(domain, secretKey) {
  // Construct the canonical wp-cron URL for the site
  const url = `https://${domain}/wp-cron.php?doing_wp_cron`;

  try {
    // Perform the GET request to wp-cron.php with helpful headers:
    // - User-Agent helps origin logs identify the caller
    // - X-Worker-Auth used for optional server-side validation (set secret on origin)
    // - Cache-Control: no-cache ensures edge or intermediary caches do not serve stale responses
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Cloudflare-Worker-Cron",    // identify the worker caller
        "X-Worker-Auth": secretKey,                // secret header for auth (configured in CF)
        "Cache-Control": "no-cache"
      },
      // cf option prevents Cloudflare Workers from caching the request at the edge
      cf: { cacheTtl: 0 }
    });

    // If the response is not OK (non-2xx), log it and return 500 to the fetch caller.
    if (!response.ok) {
      console.error(`Failed to trigger WP-Cron: ${response.status} ${response.statusText}`);
      return new Response("Cron failed", { status: 500 });
    }

    // Success path: return a plain 200 response (useful for browser tests).
    return new Response("Cron executed successfully. Yay!", { status: 200 });
  } catch (error) {
    // Catch network or runtime errors and log them
    console.error("Error triggering WP-Cron:", error);
    return new Response("Error triggering WP-Cron", { status: 500 });
  }
}