/* 
  Cloudflare Worker - MULTI-Secure
  --------------------------------
  Triggers wp-cron.php for multiple WordPress sites, each with a separate secret key
*/

export default {
  async scheduled(event, env, ctx) {
    console.log(`Multi-site secure cron triggered at: ${new Date(event.scheduledTime).toISOString()}`);
    ctx.waitUntil(runMultiCron(env));
  },
};

// Main runner
async function runMultiCron(env) {
  if (!env.MULTISITE_SITES) {
    console.error("MULTISITE_SITES variable is missing. Provide a JSON array of {domain, key} objects.");
    return;
  }

  let sites;
  try {
    sites = JSON.parse(env.MULTISITE_SITES);
    if (!Array.isArray(sites)) throw new Error("MULTISITE_SITES must be an array of objects.");
  } catch (err) {
    console.error("MULTISITE_SITES parse error:", err);
    return;
  }

  for (const site of sites) {
    if (!site.domain || !site.key) {
      console.warn("Skipping invalid site entry:", site);
      continue;
    }

    const trimmed = site.domain.replace(/\/$/, "");
    const url = `${trimmed}/wp-cron.php?doing_wp_cron`;

    try {
      console.log(`Triggering WP cron for ${url}`);

      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Cloudflare-Worker-Multi-Secure-Cron",
          "X-Worker-Auth": site.key,
          "Cache-Control": "no-cache"
        },
        cf: { cacheTtl: 0 }
      });

      if (!resp.ok) {
        const body = await safeText(resp);
        console.error(`Failed for ${url}: ${resp.status} ${resp.statusText} - ${body}`);
      } else {
        console.log(`Success for ${url}: ${resp.status}`);
      }
    } catch (err) {
      console.error(`Network or runtime error calling ${url}:`, err);
    }
  }
}