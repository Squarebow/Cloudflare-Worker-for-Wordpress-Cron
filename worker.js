/*
  Cloudflare Worker — Multi-Site WordPress Cron
  ----------------------------------------------
  Triggers wp-cron.php for multiple independent WordPress sites.
  Each site has its own secret key sent via the X-Worker-Auth header,
  so every site can verify that the request came from this Worker.

  Environment variable required:
    WP_CRON_SITES — a JSON array of { "url": "...", "key": "..." } objects.

  Example:
    [
      { "url": "https://site1.com",      "key": "secret-key-1" },
      { "url": "https://site2.net",      "key": "secret-key-2" },
      { "url": "https://blog.site3.org", "key": "secret-key-3" }
    ]
*/

// How long (in milliseconds) to wait for each WordPress site before giving up.
const FETCH_TIMEOUT_MS = 10000; // 10 seconds

export default {
  // This handler is called automatically by Cloudflare on every cron trigger.
  async scheduled(event, env, ctx) {
    console.log(`WP cron worker triggered at: ${new Date(event.scheduledTime).toISOString()}`);

    // ctx.waitUntil keeps the Worker alive until all fetches have completed,
    // even after the scheduled() function itself returns.
    ctx.waitUntil(runCronForAllSites(env));
  },
};

/**
 * Reads the list of WordPress sites from the environment variable WP_CRON_SITES,
 * then fires wp-cron.php for all of them in parallel.
 */
async function runCronForAllSites(env) {
  // --- Parse and validate the site list ---
  if (!env.WP_CRON_SITES) {
    console.error(
      'Missing environment variable: WP_CRON_SITES. ' +
      'Add a JSON array of { "url": "...", "key": "..." } objects in the Worker settings.'
    );
    return;
  }

  let sites;
  try {
    sites = JSON.parse(env.WP_CRON_SITES);
    if (!Array.isArray(sites)) {
      throw new Error('WP_CRON_SITES must be a JSON array.');
    }
  } catch (err) {
    console.error('Failed to parse WP_CRON_SITES:', err.message);
    return;
  }

  if (sites.length === 0) {
    console.warn('WP_CRON_SITES is an empty array — nothing to do.');
    return;
  }

  // --- Trigger all sites in parallel and wait for every result ---
  // Promise.allSettled never throws; each result is either { status: 'fulfilled' }
  // or { status: 'rejected', reason: ... }, so one failing site cannot block others.
  const results = await Promise.allSettled(
    sites.map((site, index) => triggerSite(site, index))
  );

  // Log a final summary so the overall outcome is easy to read in the dashboard.
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;
  console.log(`Cron run complete. ${succeeded} succeeded, ${failed} failed out of ${sites.length} sites.`);
}

/**
 * Validates a single site entry and calls wp-cron.php on it.
 * Throws on validation errors or network failures so the rejection is
 * captured by Promise.allSettled above.
 *
 * @param {object} site  - An entry from WP_CRON_SITES: { url, key }
 * @param {number} index - Position in the array, used in error messages
 */
async function triggerSite(site, index) {
  // --- Validate the site entry ---
  if (!site.url || typeof site.url !== 'string') {
    throw new Error(`Site at index ${index} is missing a valid "url" field.`);
  }
  if (!site.key || typeof site.key !== 'string') {
    throw new Error(`Site at index ${index} is missing a valid "key" field.`);
  }

  // Validate that the URL starts with https:// (http is also accepted but not recommended).
  if (!/^https?:\/\/.+/.test(site.url)) {
    throw new Error(`Site at index ${index} has an invalid URL: "${site.url}". Must start with https:// or http://.`);
  }

  // Strip any trailing slash so we don't end up with double slashes in the path.
  const baseUrl = site.url.replace(/\/+$/, '');
  const cronUrl = `${baseUrl}/wp-cron.php?doing_wp_cron`;

  // --- Set up a request timeout ---
  // AbortController lets us cancel the fetch if the server takes too long.
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    console.log(`Triggering cron for: ${baseUrl}`);

    const response = await fetch(cronUrl, {
      method: 'GET',
      headers: {
        // Identifies this request as coming from the Worker (visible in server logs).
        'User-Agent':      'Cloudflare-Worker-WP-Cron',
        // Custom header used to authenticate the request on the WordPress/server side.
        'X-Worker-Auth':   site.key,
        // Prevent any caching of this request by Cloudflare's edge.
        'Cache-Control':   'no-cache',
      },
      // Also tell Cloudflare's fetch implementation not to cache the response.
      cf: { cacheTtl: 0 },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Read a snippet of the response body to aid debugging, but cap it so
      // we don't waste resources on large error pages.
      const body = await safeText(response, 500);
      throw new Error(
        `HTTP ${response.status} ${response.statusText} from ${baseUrl} — ${body}`
      );
    }

    console.log(`OK (HTTP ${response.status}) for: ${baseUrl}`);

  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms for: ${baseUrl}`);
    }
    // Re-throw so Promise.allSettled records this as a rejection.
    throw err;
  } finally {
    // Always clear the timeout, whether the fetch succeeded or failed.
    clearTimeout(timeoutId);
  }
}

/**
 * Safely reads a limited number of characters from a fetch Response body.
 * Returns a fallback string if reading fails for any reason.
 *
 * @param {Response} response  - The fetch Response object
 * @param {number}   maxLength - Maximum characters to return (default: 200)
 * @returns {Promise<string>}
 */
async function safeText(response, maxLength = 200) {
  try {
    const text = await response.text();
    return text.slice(0, maxLength).trim() || '(empty body)';
  } catch {
    return '(could not read response body)';
  }
}
