/**
 * Cloudflare Worker — calendar relay.
 *
 * Why this exists: browsers can't fetch calendar feeds directly. Google
 * Calendar's iCal endpoint sends no Access-Control-Allow-Origin header at
 * all, and Outlook's published-calendar URLs answer with a 302 (redirects
 * drop CORS). The free public relays that fill this gap are constantly
 * rate-limited, timing out, or blocked. This is ~40 lines that does the
 * job reliably on Cloudflare's free tier (100,000 requests/day).
 *
 * It only relays. It stores nothing and logs nothing.
 *
 * Deploy:
 *   1. https://dash.cloudflare.com  →  Workers & Pages  →  Create → Worker
 *   2. Name it (e.g. "calendar-relay"), Deploy, then "Edit code"
 *   3. Replace the contents with this file, Deploy again
 *   4. Copy the URL (https://calendar-relay.<you>.workers.dev)
 *   5. Paste it into the news page: calendar card → Manage → Relay URL
 *
 * Usage:  https://your-worker.workers.dev/?url=<url-encoded ICS URL>
 */

// Only these hosts may be relayed, so the Worker can't be used as an open
// proxy by anyone who finds its URL.
const ALLOWED_HOSTS = [
  "calendar.google.com",
  "outlook.office365.com",
  "outlook.office.com",
  "outlook.live.com",
  "p01-calendarws.icloud.com",
  "caldav.icloud.com",
];

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= parameter", { status: 400, headers: cors });
    }

    let parsed;
    try {
      parsed = new URL(target.startsWith("webcal://")
        ? "https://" + target.slice("webcal://".length)
        : target);
    } catch {
      return new Response("Malformed url parameter", { status: 400, headers: cors });
    }

    if (parsed.protocol !== "https:") {
      return new Response("Only https targets are allowed", { status: 400, headers: cors });
    }
    if (!ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))) {
      return new Response("Host not allowed: " + parsed.hostname, { status: 403, headers: cors });
    }

    let upstream;
    try {
      upstream = await fetch(parsed.toString(), {
        redirect: "follow",
        headers: {
          "Accept": "text/calendar, application/octet-stream;q=0.9, */*;q=0.8",
          "User-Agent": "Mozilla/5.0 (compatible; calendar-relay/1.0)",
        },
      });
    } catch (e) {
      return new Response("Upstream fetch failed: " + e.message, { status: 502, headers: cors });
    }

    if (!upstream.ok) {
      return new Response("Upstream returned HTTP " + upstream.status, {
        status: upstream.status, headers: cors,
      });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "text/calendar; charset=utf-8",
        // Small cache so repeated loads don't re-hit the provider.
        "Cache-Control": "public, max-age=120",
      },
    });
  },
};
