#!/usr/bin/env node
// Fetches every RSS/Atom feed server-side and writes feeds.json.
// Runs in GitHub Actions, so there is no CORS involved and no proxy
// needed — this is the whole reason the site stopped depending on
// flaky public CORS proxies.

import { XMLParser } from "fast-xml-parser";
import { writeFileSync } from "node:fs";

// `gnews: true` marks Google News search feeds. Those need extra cleanup:
// titles carry a " - Publisher" suffix, the description is just a link
// blob, and the real publisher lives in a <source> element.
const GNEWS = (q) =>
  "https://news.google.com/rss/search?q=" + encodeURIComponent(q) +
  "&hl=en-US&gl=US&ceid=US:en";

const FEEDS = {
  local: [
    // Direct publisher feeds (note: cortlandvoice.com 403s on the www host)
    { name: "Cortland Voice",     url: "https://cortlandvoice.com/feed/" },
    { name: "WSYR Syracuse",      url: "https://www.localsyr.com/feed/" },
    { name: "Syracuse.com",       url: "https://www.syracuse.com/arc/outboundfeeds/rss/?outputType=xml" },
    { name: "Ithaca Voice",       url: "https://ithacavoice.org/feed/" },
    { name: "Ithaca Times",       url: "https://ithacatimes.com/search/?f=rss&t=article&l=25&s=start_time&sd=desc" },
    // Broad local coverage — survives any single publisher's feed dying,
    // and picks up outlets that never had a feed (incl. Cortland Standard).
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
    // AP's own feed endpoint is unreachable; this covers AP + wire copy.
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
    // anthropic.com no longer publishes an RSS feed.
    { name: "Anthropic",          url: GNEWS("Anthropic Claude AI"), gnews: true },
  ],
};

const PER_COLUMN_MAX = 24;
// Cap per source so a high-volume regional feed (Syracuse.com posts
// constantly) can't crowd the genuinely local outlets out of the column.
const PER_SOURCE_MAX = 4;
const FETCH_TIMEOUT_MS = 20_000;

/* ---------- sports filter ---------- */
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
  ].join("|") + ")\\b",
  "i"
);
const SPORTS_URL_RE =
  /\/(sports?|football|basketball|baseball|hockey|soccer|athletics?|nfl|nba|nhl|mlb|ncaa|olympics?)(\/|-|$)/i;

function isSports(it) {
  if (it.link && SPORTS_URL_RE.test(it.link)) return true;
  return SPORTS_TEXT_RE.test((it.title || "") + " " + (it.summary || ""));
}

/* ---------- paywall / low-signal source filter ----------
   Google News surfaces whatever matches the query, including outlets
   behind hard paywalls. Match on the <source> publisher name. */
const BLOCKED_SOURCES = [
  // Hard or metered paywalls
  "new york times", "nytimes", "washington post", "wall street journal", "wsj",
  "bloomberg", "the atlantic", "wired", "mit technology review", "technologyreview",
  "financial times", "the economist", "new yorker", "barron", "the information",
  "seeking alpha", "foreign affairs", "harvard business review", "the athletic",
  "the telegraph", "the times of london",
  // Removed at your request
  "the verge",
  // Content farms / scraper sites that Google News occasionally surfaces
  "stupiddope", "msn.com",
];

function isBlockedSource(name) {
  const n = String(name || "").toLowerCase();
  return BLOCKED_SOURCES.some(b => n.includes(b));
}

/* ---------- helpers ---------- */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
});

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// fast-xml-parser gives strings, or objects when a node had attributes.
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") {
    if (v["#text"] != null) return String(v["#text"]);
    if (v["@_href"] != null) return String(v["@_href"]);
  }
  return "";
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeImageUrl(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) return "";
  return u;
}

function extractImage(item) {
  // media:content / media:thumbnail
  for (const key of ["media:content", "media:thumbnail"]) {
    for (const node of asArray(item[key])) {
      const type = node?.["@_type"] || "";
      if (type && !String(type).startsWith("image/")) continue;
      const u = normalizeImageUrl(node?.["@_url"]);
      if (u) return u;
    }
  }
  // media:group wrapping the above
  for (const g of asArray(item["media:group"])) {
    for (const key of ["media:content", "media:thumbnail"]) {
      for (const node of asArray(g?.[key])) {
        const u = normalizeImageUrl(node?.["@_url"]);
        if (u) return u;
      }
    }
  }
  // <enclosure type="image/...">
  for (const node of asArray(item.enclosure)) {
    const type = String(node?.["@_type"] || "");
    const url = node?.["@_url"] || "";
    if (type.startsWith("image/") || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) {
      const u = normalizeImageUrl(url);
      if (u) return u;
    }
  }
  // itunes:image / image
  for (const key of ["itunes:image", "image"]) {
    for (const node of asArray(item[key])) {
      const u = normalizeImageUrl(node?.["@_href"] || node?.["@_url"] || textOf(node));
      if (u) return u;
    }
  }
  // first <img src> inside any HTML body field
  const blobs = [
    item["content:encoded"], item.description, item.content, item.summary,
  ].map(textOf).filter(Boolean);
  for (const html of blobs) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    const u = normalizeImageUrl(m && m[1]);
    if (u) return u;
  }
  return "";
}

function pickLink(item) {
  // Atom: <link rel="alternate" href="...">, possibly several
  const links = asArray(item.link);
  for (const l of links) {
    if (typeof l === "object" && l["@_href"]) {
      const rel = l["@_rel"];
      if (!rel || rel === "alternate") return String(l["@_href"]);
    }
  }
  for (const l of links) {
    const t = textOf(l);
    if (t) return t;
  }
  const guid = textOf(item.guid);
  if (/^https?:\/\//i.test(guid)) return guid;
  return "";
}

function parseFeed(xml, feed) {
  let doc;
  try { doc = parser.parse(xml); } catch { return []; }

  const rssItems  = asArray(doc?.rss?.channel?.item);
  const rdfItems  = asArray(doc?.["rdf:RDF"]?.item);
  const atomItems = asArray(doc?.feed?.entry);
  const raw = rssItems.length ? rssItems : (rdfItems.length ? rdfItems : atomItems);

  return raw.map((item) => {
    let title = stripHtml(textOf(item.title)) || "(untitled)";
    const date =
      textOf(item.pubDate) || textOf(item["dc:date"]) ||
      textOf(item.published) || textOf(item.updated) || "";
    let summary = stripHtml(
      textOf(item.description) || textOf(item.summary) ||
      textOf(item["content:encoded"]) || textOf(item.content)
    ).slice(0, 260);
    let source = feed.name;

    if (feed.gnews) {
      // Google News puts the real publisher in <source> and appends
      // " - Publisher" to the title. The description is a link blob, not
      // a summary, so drop it rather than render junk.
      const pub = stripHtml(textOf(item.source));
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
      link: pickLink(item),
      date: date ? new Date(date).toISOString() : "",
      summary,
      image: extractImage(item),
      source,
    };
  }).filter(it => it.link);
}

async function fetchFeed(feed) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        // Some publishers 403 unknown agents.
        "User-Agent": "Mozilla/5.0 (compatible; news-discover/1.0; +https://github.com/eman5oh/news-discover)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const xml = await res.text();
    const items = parseFeed(xml, feed);
    if (!items.length) throw new Error("no items parsed");
    return items;
  } finally {
    clearTimeout(timer);
  }
}

async function buildColumn(category) {
  const feeds = FEEDS[category];
  const status = {};
  const settled = await Promise.allSettled(feeds.map(fetchFeed));

  const items = [];
  settled.forEach((r, i) => {
    const name = feeds[i].name;
    if (r.status === "fulfilled") {
      status[name] = "ok";
      items.push(...r.value);
    } else {
      status[name] = String(r.reason?.message || r.reason || "failed");
      console.error(`  ✗ ${name}: ${status[name]}`);
    }
  });

  const filtered = items.filter(it => !isSports(it) && !isBlockedSource(it.source));
  const noSports = filtered;

  noSports.sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : 0;
    const tb = b.date ? Date.parse(b.date) : 0;
    return (tb || 0) - (ta || 0);
  });

  const seen = new Set();
  const unique = [];
  for (const it of noSports) {
    const key = it.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (key && !seen.has(key)) { seen.add(key); unique.push(it); }
  }

  // Walk newest-first, keeping at most PER_SOURCE_MAX from any one source.
  const perSource = new Map();
  const kept = [];
  for (const it of unique) {
    const n = perSource.get(it.source) || 0;
    if (n >= PER_SOURCE_MAX) continue;
    perSource.set(it.source, n + 1);
    kept.push(it);
    if (kept.length >= PER_COLUMN_MAX) break;
  }

  console.log(`${category}: ${kept.length} items from ${perSource.size} sources ` +
              `(${Object.values(status).filter(s => s === "ok").length}/${feeds.length} feeds ok)`);
  return { items: kept, status };
}

async function main() {
  const columns = {};
  const sourceStatus = {};

  for (const category of Object.keys(FEEDS)) {
    const { items, status } = await buildColumn(category);
    columns[category] = items;
    Object.assign(sourceStatus, status);
  }

  const total = Object.values(columns).reduce((n, a) => n + a.length, 0);
  if (total === 0) {
    console.error("Every feed failed — refusing to overwrite feeds.json with an empty file.");
    process.exit(1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    columns,
    sourceStatus,
  };
  writeFileSync("feeds.json", JSON.stringify(payload, null, 1) + "\n");
  console.log(`\nWrote feeds.json — ${total} items total.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
