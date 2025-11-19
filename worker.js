/* JS Worker for wp-cron.php */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    
    // If the request is for wp-cron.php, trigger the cron job
    if (url.pathname === "/wp-cron.php") {
      return handleScheduled(env.DEFAULT_DOMAIN, env.WORKER_SECRET_KEY);
    }

    // Allow all other requests to pass through normally
    return fetch(req);
  },

  async scheduled(event, env, ctx) {
    console.log(`Cron triggered at: ${new Date(event.scheduledTime).toISOString()}`);
    ctx.waitUntil(handleScheduled(env.DEFAULT_DOMAIN, env.WORKER_SECRET_KEY));
  },
};

async function handleScheduled(domain, secretKey) {
  const url = `https://${domain}/wp-cron.php?doing_wp_cron`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Cloudflare-Worker-Cron",
        "X-Worker-Auth": secretKey,
        "Cache-Control": "no-cache"
      },
      cf: { cacheTtl: 0 }
    });

    if (!response.ok) {
      console.error(`Failed to trigger WP-Cron: ${response.status} ${response.statusText}`);
      return new Response("Cron failed", { status: 500 });
    }

    return new Response("Cron executed successfully", { status: 200 });
  } catch (error) {
    console.error("Error triggering WP-Cron:", error);
    return new Response("Error triggering WP-Cron", { status: 500 });
  }
}