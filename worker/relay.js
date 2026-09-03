/**
 * Cloudflare Worker — news + calendar relay for the Discover page.
 *
 * Two jobs, two endpoints:
 *
 *   GET /calendar?url=<url-encoded ICS URL>
 *       Relays a calendar feed with CORS headers. Necessary because
 *       browsers can't fetch these directly: calendar.google.com sends no
 *       Access-Control-Allow-Origin header at all, and Outlook's published
 *       calendar URLs answer with a 302 (redirects drop CORS).
 *
 *   GET /feeds
 *       Fetches every news feed, parses, filters and returns exactly the
 *       same JSON shape as the feeds.json that GitHub Actions commits.
 *       This is the live fallback: the page normally reads the committed
 *       feeds.json (instant), and falls back here when that file is stale
 *       or missing — e.g. if the scheduled Action fails.
 *
 *   GET /health
 *       Returns "ok". Handy for checking the deploy worked.
 *
 * Stores nothing, logs nothing. Both endpoints are host-allowlisted so
 * this can't be used as a general open proxy by anyone who finds the URL.
 *
 * Deploy instructions: see SETUP.md in the repo root.
 *
 * NOTE: FEEDS below mirrors the list in scripts/fetch-feeds.mjs. If you
 * add or remove a feed, change it in BOTH files.
 */

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const GNEWS = (q) =>
  "https://news.google.com/rss/search?q=" + encodeURIComponent(q) +
  "&hl=en-US&gl=US&ceid=US:en";

const FEEDS = {
  local: [
    { name: "Cortland Voice",     url: "https://cortlandvoice.com/feed/" },
    { name: "WSYR Syracuse",      url: "https://www.localsyr.com/feed/" },
    { name: "Syracuse.com",       url: "https://www.syracuse.com/arc/outboundfeeds/rss/?outputType=xml" },
    { name: "Ithaca Voice",       url: "https://ithacavoice.org/feed/" },
    { name: "Ithaca Times",       url: "https://ithacatimes.com/search/?f=rss&t=article&l=25&s=start_time&sd=desc" },
    { name: "Cortland area",      url: GNEWS('"Cortland" OR "Cortland County" New York'), gnews: true },
    { name: "Ithaca area",        url: GNEWS('Ithaca OR "Tompkins County" New York'),     gnews: true },
    { name: "Cornell Daily Sun",  url: GNEWS("site:cornellsun.com"),                      gnews: true },
  ],
  national: [
    { name: "NPR News",           url: "https://feeds.npr.org/1001/rss.xml" },
    { name: "BBC US & Canada",    url: "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml" },
    { name: "PBS NewsHour",       url: "https://www.pbs.org/newshour/feeds/rss/headlines" },
    { name: "CBS News",           url: "https://www.cbsnews.com/latest/rss/main" },
    { name: "ABC News",           url: "https://abcnews.go.com/abcnews/topstories" },
    { name: "The Guardian US",    url: "https://www.theguardian.com/us-news/rss" },
    { name: "US headlines",       url: "https://news.google.com/rss/headlines/section/topic/NATION?hl=en-US&gl=US&ceid=US:en", gnews: true },
  ],
  tech: [
    { name: "TechCrunch AI",      url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
    { name: "Ars Technica AI",    url: "https://arstechnica.com/ai/feed/" },
    { name: "VentureBeat AI",     url: "https://venturebeat.com/category/ai/feed/" },
    { name: "OpenAI Blog",        url: "https://openai.com/blog/rss.xml" },
    { name: "Google AI",          url: "https://blog.google/technology/ai/rss/" },
    { name: "Simon Willison",     url: "https://simonwillison.net/atom/everything/" },
    { name: "TechCrunch",         url: "https://techcrunch.com/feed/" },
    { name: "Ars Technica",       url: "https://feeds.arstechnica.com/arstechnica/index" },
    { name: "Engadget",           url: "https://www.engadget.com/rss.xml" },
    { name: "The Register",       url: "https://www.theregister.com/headlines.atom" },
    { name: "9to5Mac",            url: "https://9to5mac.com/feed/" },
    { name: "404 Media",          url: "https://www.404media.co/rss/" },
    { name: "Hacker News",        url: "https://hnrss.org/frontpage" },
    { name: "Anthropic",          url: GNEWS("Anthropic Claude AI"), gnews: true },
  ],
};

// Calendar hosts. Matched as an exact hostname OR a parent domain, so
// icloud.com covers its rotating p01-/p02-calendarws prefixes.
const CALENDAR_HOSTS = [
  "calendar.google.com",
  "outlook.office365.com",
  "outlook.office.com",
  "outlook.live.com",
  "icloud.com",
];

const PER_COLUMN_MAX = 24;
const PER_SOURCE_MAX = 4;
// One slow publisher shouldn't hold up the whole response — the others
// have already returned by then.
const FEED_TIMEOUT_MS = 8_000;

const SPORTS_TEXT_RE = new RegExp(
  "\\b(" + [
    "sports?", "football", "basketball", "baseball", "hockey", "soccer",
    "lacrosse", "tennis", "golf", "wrestling", "gymnastics", "volleyball",
    "softball", "rugby", "cricket", "boxing", "MMA", "UFC", "NASCAR", "F1",
    "athletes?", "athletics?", "athletic",
    "NFL", "NBA", "NHL", "MLB", "MLS", "NCAA", "PGA", "LPGA", "FIFA", "UEFA", "ESPN",
    "olympics?", "olympian", "paralympics?",
    "quarterback", "touchdown", "halftime", "scoreless", "shutout",
    "kickoff", "championships?", "playoffs?", "tournament", "tournaments",
    "head coach", "coaching staff", "season opener", "season finale",
    "cornell big red", "big red sports", "red raiders", "red dragons",
    "ithaca bombers", "syracuse orange",
  ].join("|") + ")\\b", "i"
);
const SPORTS_URL_RE =
  /\/(sports?|football|basketball|baseball|hockey|soccer|athletics?|nfl|nba|nhl|mlb|ncaa|olympics?)(\/|-|$)/i;

const BLOCKED_SOURCES = [
  "new york times", "nytimes", "washington post", "wall street journal", "wsj",
  "bloomberg", "the atlantic", "wired", "mit technology review", "technologyreview",
  "financial times", "the economist", "new yorker", "barron", "the information",
  "seeking alpha", "foreign affairs", "harvard business review", "the athletic",
  "the telegraph", "the times of london", "the verge",
  "stupiddope", "msn.com",
];

/* ------------------------------------------------------------------ */
/* Minimal XML helpers — Workers have no DOMParser, and the dashboard   */
/* editor has no bundler, so this is deliberately dependency-free.      */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&");
}

function stripTags(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// All <tag ...>...</tag> blocks (and self-closing <tag ... />).
function blocks(xml, tag) {
  const re = new RegExp(`<${tag}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({ attrs: m[1] || "", inner: m[2] || "", all: m[0] });
  }
  return out;
}

function firstBlock(xml, tag) {
  return blocks(xml, tag)[0] || null;
}

function tagText(xml, tag) {
  const b = firstBlock(xml, tag);
  return b ? decodeEntities(b.inner).trim() : "";
}

function attr(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs || "");
  return m ? m[1] : "";
}

function normalizeImage(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (u.startsWith("//")) u = "https:" + u;
  return /^https?:\/\//i.test(u) ? u : "";
}

function extractImage(itemXml) {
  for (const tag of ["media:content", "media:thumbnail"]) {
    for (const b of blocks(itemXml, tag)) {
      const type = attr(b.attrs, "type");
      if (type && !type.startsWith("image/")) continue;
      const u = normalizeImage(attr(b.attrs, "url"));
      if (u) return u;
    }
  }
  for (const b of blocks(itemXml, "enclosure")) {
    const type = attr(b.attrs, "type");
    const url = attr(b.attrs, "url");
    if (type.startsWith("image/") || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) {
      const u = normalizeImage(url);
      if (u) return u;
    }
  }
  for (const b of blocks(itemXml, "itunes:image")) {
    const u = normalizeImage(attr(b.attrs, "href") || attr(b.attrs, "url"));
    if (u) return u;
  }
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(decodeEntities(itemXml));
  return normalizeImage(m && m[1]);
}

function pickLink(itemXml) {
  // Atom <link href="..." rel="alternate"/> first
  for (const b of blocks(itemXml, "link")) {
    const href = attr(b.attrs, "href");
    if (!href) continue;
    const rel = attr(b.attrs, "rel");
    if (!rel || rel === "alternate") return href;
  }
  const plain = tagText(itemXml, "link");
  if (/^https?:\/\//i.test(plain)) return plain;
  const guid = tagText(itemXml, "guid");
  return /^https?:\/\//i.test(guid) ? guid : "";
}

function parseFeed(xml, feed) {
  let raw = blocks(xml, "item");
  if (!raw.length) raw = blocks(xml, "entry");

  return raw.map(({ inner }) => {
    let title = stripTags(tagText(inner, "title")) || "(untitled)";
    let summary = stripTags(
      tagText(inner, "description") || tagText(inner, "summary") ||
      tagText(inner, "content:encoded") || tagText(inner, "content")
    ).slice(0, 260);
    let source = feed.name;

    const rawDate =
      tagText(inner, "pubDate") || tagText(inner, "dc:date") ||
      tagText(inner, "published") || tagText(inner, "updated");
    const parsed = rawDate ? Date.parse(rawDate) : NaN;

    if (feed.gnews) {
      // Google News: real publisher lives in <source>, the title carries a
      // " - Publisher" suffix, and the description is a link blob, not prose.
      const pub = stripTags(tagText(inner, "source"));
      if (pub) {
        source = pub;
        if (title.endsWith(" - " + pub)) title = title.slice(0, -(pub.length + 3)).trim();
      } else {
        title = title.replace(/\s+-\s+[^-]{2,40}$/, "").trim();
      }
      summary = "";
    }

    return {
      title,
      link: pickLink(inner),
      date: Number.isNaN(parsed) ? "" : new Date(parsed).toISOString(),
      summary,
      image: extractImage(inner),
      source,
    };
  }).filter(it => it.link);
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

function isSports(it) {
  if (it.link && SPORTS_URL_RE.test(it.link)) return true;
  return SPORTS_TEXT_RE.test((it.title || "") + " " + (it.summary || ""));
}
function isBlockedSource(name) {
  const n = String(name || "").toLowerCase();
  return BLOCKED_SOURCES.some(b => n.includes(b));
}

async function fetchOneFeed(feed) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; news-discover/1.0)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const items = parseFeed(await res.text(), feed);
    if (!items.length) throw new Error("no items parsed");
    return items;
  } finally {
    clearTimeout(timer);
  }
}

async function buildFeedsPayload() {
  // Fetch every feed across all three columns in ONE parallel batch.
  // Doing a Promise.allSettled per category serialised three rounds, so
  // each column waited on its own slowest feed before the next started —
  // three timeouts deep in the worst case.
  const jobs = [];
  for (const [category, feeds] of Object.entries(FEEDS)) {
    for (const feed of feeds) jobs.push({ category, feed });
  }
  const settled = await Promise.allSettled(jobs.map(j => fetchOneFeed(j.feed)));

  const byCategory = {};
  const sourceStatus = {};
  settled.forEach((r, i) => {
    const { category, feed } = jobs[i];
    if (!byCategory[category]) byCategory[category] = [];
    if (r.status === "fulfilled") {
      sourceStatus[feed.name] = "ok";
      byCategory[category].push(...r.value);
    } else {
      sourceStatus[feed.name] = String(r.reason?.message || r.reason || "failed");
    }
  });

  const columns = {};
  for (const category of Object.keys(FEEDS)) {
    const items = byCategory[category] || [];
    const filtered = items.filter(it => !isSports(it) && !isBlockedSource(it.source));
    filtered.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

    const seen = new Set();
    const perSource = new Map();
    const kept = [];
    for (const it of filtered) {
      const key = it.title.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      const n = perSource.get(it.source) || 0;
      if (n >= PER_SOURCE_MAX) continue;
      seen.add(key);
      perSource.set(it.source, n + 1);
      kept.push(it);
      if (kept.length >= PER_COLUMN_MAX) break;
    }
    columns[category] = kept;
  }

  return { generatedAt: new Date().toISOString(), columns, sourceStatus, via: "worker" };
}

/* ------------------------------------------------------------------ */
/* Request handling                                                    */
/* ------------------------------------------------------------------ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function hostAllowed(hostname, list) {
  return list.some(h => hostname === h || hostname.endsWith("." + h));
}

function text(body, status) {
  return new Response(body, { status, headers: CORS });
}

async function handleCalendar(target) {
  if (!target) return text("Missing ?url= parameter", 400);

  let parsed;
  try {
    parsed = new URL(target.startsWith("webcal://")
      ? "https://" + target.slice("webcal://".length)
      : target);
  } catch {
    return text("Malformed url parameter", 400);
  }

  if (parsed.protocol !== "https:") return text("Only https targets are allowed", 400);
  if (!hostAllowed(parsed.hostname, CALENDAR_HOSTS)) {
    return text("Host not allowed: " + parsed.hostname, 403);
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
    return text("Upstream fetch failed: " + e.message, 502);
  }
  if (!upstream.ok) return text("Upstream returned HTTP " + upstream.status, upstream.status);

  return new Response(upstream.body, {
    status: 200,
    headers: { ...CORS, "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "public, max-age=120" },
  });
}

async function handleFeeds() {
  let payload;
  try {
    payload = await buildFeedsPayload();
  } catch (e) {
    return text("Aggregation failed: " + e.message, 502);
  }
  const total = Object.values(payload.columns).reduce((n, a) => n + a.length, 0);
  if (total === 0) return text("Every feed failed", 502);

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      // Edge-cache briefly so repeated refreshes don't re-hit 29 publishers.
      "Cache-Control": "public, max-age=300",
    },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return text("Method not allowed", 405);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") return text("ok", 200);
    if (path === "/feeds")  return handleFeeds();

    // "/calendar?url=..." is the documented form. A bare "/?url=..." is
    // also accepted so an older configured relay URL keeps working.
    if (path === "/calendar" || path === "/") {
      return handleCalendar(url.searchParams.get("url"));
    }

    return text("Not found. Endpoints: /calendar?url=…  /feeds  /health", 404);
  },
};
