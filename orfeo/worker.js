/*
  Cloudflare Worker — GitHub Workflow Starter v1.0.0
  -------------------------------------------------------------------
  Starts GitHub Actions workflows at a fixed local time each day, on
  time. GitHub's own `schedule:` trigger is best-effort and often starts
  hours late or not at all; this Worker calls the "run workflow" API
  (workflow_dispatch) instead, from Cloudflare's punctual Cron Triggers.

  Made for the Orfeo stats (Squarebow/Orfeo, stats.yml, 07:00
  Ljubljana), but works for any repository and workflow.

  Cron Trigger:  * * * * *   (every minute; the Worker decides when to start)

  Variables (Settings → Variables and Secrets):
    GITHUB_TOKEN   Secret. Fine-grained personal access token with access to
                   the job's repository only, permission "Actions: Read and
                   write". Nothing else.
    JOBS           Secret or JSON. Array of jobs, e.g.:
                   [
                     {
                       "repo": "Squarebow/Orfeo",
                       "workflow": "stats.yml",
                       "ref": "main",
                       "at": "07:00",
                       "timeZone": "Europe/Ljubljana",
                       "inputs": { "daily": "true" }
                     }
                   ]
                   Optional per job: "retryMinutes" (default 30): how long
                   to keep retrying after "at" if GitHub refuses or fails.
    DASHBOARD_KEY  Optional Secret. When set, ?status only opens with
                   &key=<the same value> in the address.

  KV binding (recommended): STARTER_KV
    With it, a failed start is retried every minute for retryMinutes and a
    job never starts twice on the same day. Without it, each job gets one
    attempt, at exactly "at".
    Writes: one per attempt inside the retry window (normally 1 a day).

  Dashboard:  https://your-worker.workers.dev/?status
*/

// ─── Configuration ──────────────────────────────────────────────────────────

const VERSION = "1.0.0";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_MINUTES = 30;
const KV_TTL_SECONDS = 7 * 24 * 3600; // keep a week of results
const GITHUB_API = "https://api.github.com";


// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...HEADERS },
  });
}

/** Local date and minute of the day of `ms` in `timeZone` (handles summer time). */
function localClock(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Validate JOBS and return a clean array. Throws with a readable message. */
function parseJobs(env) {
  if (!env.JOBS) throw new Error("JOBS variable is not set.");
  let jobs = env.JOBS;
  if (!Array.isArray(jobs)) {
    try { jobs = JSON.parse(jobs); } catch { throw new Error("JOBS is not valid JSON."); }
  }
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("JOBS must be a non-empty JSON array.");

  return jobs.map((j, i) => {
    const where = `JOBS[${i}]`;
    if (typeof j.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(j.repo)) throw new Error(`${where}.repo must look like "owner/name".`);
    if (typeof j.workflow !== "string" || !/^([\w.-]+\.ya?ml|\d+)$/.test(j.workflow)) throw new Error(`${where}.workflow must be a file name like "stats.yml" (or a workflow id).`);
    if (typeof j.ref !== "string" || !j.ref) throw new Error(`${where}.ref must be a branch or tag, e.g. "main".`);
    const m = typeof j.at === "string" && /^(\d{2}):(\d{2})$/.exec(j.at);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`${where}.at must be "HH:MM", e.g. "07:00".`);
    const timeZone = j.timeZone || "UTC";
    try { new Intl.DateTimeFormat("en", { timeZone }); } catch { throw new Error(`${where}.timeZone "${timeZone}" is not a time zone, e.g. "Europe/Ljubljana".`); }
    const retryMinutes = j.retryMinutes ?? DEFAULT_RETRY_MINUTES;
    if (!Number.isInteger(retryMinutes) || retryMinutes < 0 || retryMinutes > 720) throw new Error(`${where}.retryMinutes must be a whole number from 0 to 720.`);
    const inputs = {};
    for (const [k, v] of Object.entries(j.inputs ?? {})) inputs[k] = String(v); // GitHub wants strings
    return {
      id: `${j.repo}/${j.workflow}@${j.ref}`,
      repo: j.repo, workflow: j.workflow, ref: j.ref,
      at: j.at, atMinute: Number(m[1]) * 60 + Number(m[2]),
      timeZone, retryMinutes, inputs,
    };
  });
}

/**
 * Is `ms` inside this job's start window, and for which local day?
 * The window runs from "at" for retryMinutes (it may cross midnight; the day
 * is the one the window started on).
 */
function windowFor(job, ms) {
  const now = localClock(ms, job.timeZone);
  const since = (now.minute - job.atMinute + 1440) % 1440; // minutes since "at"
  const span = Math.max(1, job.retryMinutes);
  if (since >= span) return null;
  const day = since === 0 ? now.date : localClock(ms - since * 60_000, job.timeZone).date;
  return { day, since };
}


// ─── GitHub ─────────────────────────────────────────────────────────────────

async function startWorkflow(job, token) {
  const url = `${GITHUB_API}/repos/${job.repo}/actions/workflows/${encodeURIComponent(job.workflow)}/dispatches`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": `Cloudflare-Worker-GitHub-Workflow-Starter/${VERSION}`,
      },
      body: JSON.stringify({ ref: job.ref, inputs: job.inputs }),
      signal: controller.signal,
    });
    let message = null;
    if (!res.ok) {
      try { message = (await res.json()).message ?? null; } catch { message = null; }
    }
    return { success: res.ok, status: res.status, error: res.ok ? null : (message ?? `HTTP ${res.status}`).slice(0, 300), startedAt, finishedAt: new Date().toISOString() };
  } catch (err) {
    return { success: false, status: null, error: err.name === "AbortError" ? `Timed out after ${REQUEST_TIMEOUT_MS} ms` : String(err.message ?? err).slice(0, 300), startedAt, finishedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}


// ─── Scheduled run ──────────────────────────────────────────────────────────

async function handleScheduled(env, scheduledTime) {
  const jobs = parseJobs(env);
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set.");
  const kv = env.STARTER_KV ?? null;

  for (const job of jobs) {
    const win = windowFor(job, scheduledTime);
    if (!win) continue;
    if (!kv && win.since !== 0) continue;         // no KV: one attempt, at "at"

    const doneKey = `done:${job.id}:${win.day}`;
    if (kv && await kv.get(doneKey)) continue;    // already started today

    const result = { job: job.id, day: win.day, attempt: win.since + 1, ...(await startWorkflow(job, env.GITHUB_TOKEN)) };
    if (result.success) {
      console.log(`Started ${job.id} for ${win.day}.`);
    } else {
      console.error(`Could not start ${job.id} for ${win.day} (attempt ${result.attempt}): ${result.error}`);
    }

    if (kv) {
      const opts = { expirationTtl: KV_TTL_SECONDS };
      await kv.put(`last:${job.id}`, JSON.stringify(result), opts);
      if (result.success) await kv.put(doneKey, result.finishedAt, opts);
    }
  }
}


// ─── Dashboard ──────────────────────────────────────────────────────────────

function nextStart(job, nowMs) {
  // Shown on the dashboard only; may be an hour off on the night the clocks change.
  const now = localClock(nowMs, job.timeZone);
  let minutes = (job.atMinute - now.minute + 1440) % 1440;
  if (minutes === 0) minutes = 1440;
  return new Date(Math.floor(nowMs / 60_000) * 60_000 + minutes * 60_000);
}

function renderHTML(rows, now) {
  const fmt = (iso, tz) => iso ? new Date(iso).toLocaleString("sl-SI", { timeZone: tz }) : "—";
  const cards = rows.map(({ job, last, next }) => {
    const state = !last ? "unknown" : last.success ? "ok" : "fail";
    const badge = !last ? "No start yet" : last.success ? "✓ Started" : "✗ Failed";
    return `
    <div class="card ${state}">
      <div class="card-header">
        <span class="name">${escapeHtml(job.repo)} · ${escapeHtml(job.workflow)}</span>
        <span class="badge badge-${state}">${escapeHtml(badge)}</span>
      </div>
      <div class="card-meta">
        <span>Daily at ${escapeHtml(job.at)} ${escapeHtml(job.timeZone)} on ${escapeHtml(job.ref)}</span>
        <span>Last: ${escapeHtml(fmt(last?.finishedAt, job.timeZone))}${last ? ` (HTTP ${escapeHtml(last.status ?? "—")}, attempt ${escapeHtml(last.attempt)})` : ""}</span>
        <span>Next: ${escapeHtml(fmt(next.toISOString(), job.timeZone))}</span>
      </div>
      ${last?.error ? `<div class="card-error">${escapeHtml(last.error)}</div>` : ""}
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Workflow Starter</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f0f2f5; color: #1a1a2e; padding: 2rem; }
    header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
    h1 { font-size: 1.4rem; }
    .meta { font-size: 0.8rem; color: #888; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
    .card { background: white; border-radius: 10px; padding: 1.1rem 1.2rem; border-left: 4px solid #d1d5db; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .card.ok { border-left-color: #22c55e; } .card.fail { border-left-color: #ef4444; }
    .card-header { display: flex; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .name { font-weight: 700; word-break: break-all; }
    .card-meta { display: grid; gap: 0.2rem; font-size: 0.8rem; color: #666; }
    .card-error { margin-top: 0.6rem; font-size: 0.78rem; color: #ef4444; background: #fef2f2; border-radius: 4px; padding: 0.3rem 0.5rem; word-break: break-word; }
    .badge { padding: 2px 8px; border-radius: 20px; font-size: 0.72rem; font-weight: 700; white-space: nowrap; }
    .badge-ok { background: #dcfce7; color: #16a34a; } .badge-fail { background: #fee2e2; color: #dc2626; } .badge-unknown { background: #f3f4f6; color: #9ca3af; }
    @media (max-width: 500px) { body { padding: 1rem; } .cards { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header><h1>Workflow Starter</h1><span class="meta">Updated: ${escapeHtml(new Date(now).toLocaleString("sl-SI", { timeZone: "Europe/Ljubljana" }))}</span></header>
  <div class="cards">${cards}</div>
</body>
</html>`;
}

async function handleDashboard(request, env) {
  const url = new URL(request.url);
  if (env.DASHBOARD_KEY && !safeEqual(url.searchParams.get("key") ?? "", env.DASHBOARD_KEY)) {
    return jsonResponse({ error: "This dashboard needs its key: add &key=<DASHBOARD_KEY> to the address." }, 401);
  }
  let jobs;
  try { jobs = parseJobs(env); } catch (err) { return jsonResponse({ error: err.message }, 500); }

  const now = Date.now();
  const rows = await Promise.all(jobs.map(async (job) => {
    const raw = env.STARTER_KV ? await env.STARTER_KV.get(`last:${job.id}`) : null;
    return { job, last: raw ? JSON.parse(raw) : null, next: nextStart(job, now) };
  }));

  if ((request.headers.get("Accept") || "").includes("text/html")) {
    return new Response(renderHTML(rows, now), { headers: { "Content-Type": "text/html; charset=utf-8", ...HEADERS } });
  }
  return jsonResponse(rows.map(({ job, last, next }) => ({
    job: job.id, at: job.at, timeZone: job.timeZone, last, next: next.toISOString(),
  })));
}


// ─── Entry points ───────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    await handleScheduled(env, event.scheduledTime);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.searchParams.has("status")) return handleDashboard(request, env);
    return jsonResponse({
      worker: "GitHub Workflow Starter",
      version: VERSION,
      status: "active",
      tip: "Add ?status to see the jobs.",
      time: new Date().toISOString(),
    });
  },
};
