# 🌐 Cloudflare Worker for WordPress Cron
### **Multi-Site Secure Version**
Trigger `wp-cron.php` for multiple independent WordPress sites with **individual secret keys** for maximum security.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![WordPress](https://img.shields.io/badge/WordPress-Cron-21759B?logo=wordpress&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Status](https://img.shields.io/badge/Mode-Multi--Site--Secure-purple)
![Cron Powered](https://img.shields.io/badge/Cron-1min%20interval-success)

---

## 📚 Table of Contents
- [Overview](#-overview)
- [Why Multi-Site Secure Mode?](#-why-multi-site-secure-mode)
- [Key Features](#-key-features)
- [How It Works](#-how-it-works)
- [Setup Instructions](#%EF%B8%8F-setup-instructions)
- [Adding Multiple Sites](#-adding-multiple-sites)
- [Troubleshooting](#-troubleshooting)
- [Extra Notes & Optional Security Enhancements](#-extra-notes--optional-security-enhancements)

---

## 📝 Overview
This Worker runs on a scheduled trigger and loops through a list of WordPress sites, each with its own **secret key**. This ensures secure, independent cron execution for each site.

---

## ⚡ Why Multi-Site Secure Mode?
- ✅ Maximum security: each site has its own secret  
- ✅ Centralized cron for unlimited sites  
- ✅ No Cloudflare Worker route required  
- ✅ Easy to expand domains  
- ✅ Avoids shared secret risks  

---

## 🌟 Key Features
- Unlimited WordPress sites  
- Individual secret keys per site  
- 1-minute Cron trigger  
- No routes needed  
- Centralized codebase  
- Logging & observability via Cloudflare dashboard  

---

## 🔧 How It Works
The worker reads a **JSON array of objects** from the environment variable `MULTISITE_SITES`. Each object includes:

| Field   | Description                             |
|---------|-----------------------------------------|
| domain  | Full site URL (https://site1.com)       |
| key     | Secret key for X-Worker-Auth header     |

Example JSON array in **Cloudflare Variable**:

```json
[
  { "domain": "https://site1.com", "key": "secret1" },
  { "domain": "https://site2.net", "key": "secret2" },
  { "domain": "https://blog.site3.org", "key": "secret3" }
]
```

The worker loops through each site and triggers:

```
https://{domain}/wp-cron.php?doing_wp_cron
```

with the corresponding `X-Worker-Auth` header.

---

## ⚙️ Setup Instructions

1. **Create Worker**  
   - Paste the JS worker code below.  

2. **Set Environment Variables**  

| Name               | Type       | Value Example                                                      |
|-------------------|-----------|--------------------------------------------------------------------|
| `MULTISITE_SITES`  | Plaintext | JSON array as shown above                                           |

> Each object contains `domain` and `key`.

3. **Add Cron Trigger**  
   - Example: `*/1 * * * *` (every minute)  

4. **Disable WP Cron in all sites**  
```php
define('DISABLE_WP_CRON', true);
```

5. **Test**  
- Visit any `https://siteX.com/wp-cron.php?doing_wp_cron` to confirm it works.  

6. **Monitor Logs**  
- Use Cloudflare Worker dashboard → Observability → Logs.  

---

## 🔒 Optional Security (WordPress server)

**Apache:**
```apache
<Files "wp-cron.php">
  Order Deny,Allow
  Deny from all
  <IfModule mod_headers.c>
    SetEnvIf X-Worker-Auth "^.{1,}$" worker_auth=true
  </IfModule>
  Allow from env=worker_auth
</Files>
```

**Nginx:**
```nginx
location = /wp-cron.php {
    if ($http_x_worker_auth = "") { return 403; }
    fastcgi_pass php-handler;
}
```

---

## 🛠 Troubleshooting
- ❌ 1101 Worker error → check JS logs  
- ❌ Cron not firing → verify JSON syntax in `MULTISITE_SITES`  
- ❌ Unauthorized → verify each site’s `key` matches X-Worker-Auth header  
- ❌ 404 → ensure WP sites have `/wp-cron.php` endpoint accessible  

---

## 💻 Multi-Site Secure Worker JS Code

```js
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

// Helper to safely read small response bodies
async function safeText(response) {
  try { return await response.text(); } 
  catch { return "<unreadable body>"; }
}
```