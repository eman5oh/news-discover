# Setup

The site has two moving parts behind it. You only have to set these up once.

| Part | What it does | Cost |
|---|---|---|
| **GitHub Actions** | Every 15 min, fetches all 29 news feeds and publishes the site (`index.html` + `feeds.json`) straight to Pages. | Free |
| **Cloudflare Worker** | Relays your calendar (browsers can't fetch calendars directly), and gives the news a live fallback. | Free |

---

## Part 1 — GitHub Actions (news)

**Already set up and running.** Nothing to do. It's here for reference.

The **Build and deploy** workflow runs every 15 minutes. It fetches the
feeds, assembles `index.html` + `feeds.json` into a `_site/` folder, and
deploys that folder to GitHub Pages as an artifact.

Nothing is committed to the repo. Pages is configured with
`build_type: workflow` rather than serving from a branch, so the repo
doesn't grow over time. `feeds.json` is generated, not tracked — it's
in `.gitignore`.

To refresh by hand: **Actions** → **Build and deploy** → **Run workflow**.

**Two things worth knowing:**

- GitHub runs scheduled jobs several minutes late when it's busy. Not a
  problem for headlines.
- Scheduled workflows get **auto-disabled after 60 days of no repo
  activity**. Since this workflow no longer commits anything, its own runs
  may not count as activity — so if you don't touch the repo for two
  months, check the Actions tab and re-enable it. (With the Worker
  configured, the page still gets live headlines via **Refresh** even if
  that happens.)

### Running it locally

`feeds.json` isn't in the repo, so generate it first:

```bash
npm install --no-save fast-xml-parser
node scripts/fetch-feeds.mjs
python3 -m http.server 8765
```

Then open http://localhost:8765.

---

## Part 2 — Cloudflare Worker (calendar + live news)

### Why this is needed

Your calendar can't use the Actions trick. The Action commits its output to a **public** repo — fine for news headlines, but your calendar event titles must not go there. So the calendar has to be fetched live, in your browser.

But a browser can't fetch a calendar directly either. I verified both:

- `calendar.google.com` returns **no `Access-Control-Allow-Origin` header at all**
- Outlook's published-calendar URLs answer with a **302 redirect**, and redirects drop CORS

So something has to sit in the middle. Until now that was free public relay services, which is why the calendar kept failing — when I tested them from a real browser, **all five were broken at once** (rate-limited, timing out, or returning their own error page instead of your data).

This Worker replaces them with one you control.

### Steps

**1.** Go to **https://dash.cloudflare.com** and sign in (create a free account if needed — no card required).

**2.** In the left sidebar: **Compute (Workers)** → **Workers & Pages** → **Create** → **Start with Hello World!** → **Deploy**.

Cloudflare will ask for a name. Use **`news-relay`**.

**3.** Once deployed, click **Edit code** (or **Continue to project** → **Edit code**).

**4.** In the editor, select everything in the file and delete it. Then paste the entire contents of **`worker/relay.js`** from this repo.

Direct link once pushed:
https://github.com/eman5oh/news-discover/blob/main/worker/relay.js

**5.** Click **Deploy** (top right).

**6.** Copy your Worker's URL. It looks like:

```
https://news-relay.YOUR-SUBDOMAIN.workers.dev
```

**7.** Verify it works — open this in a browser tab:

```
https://news-relay.YOUR-SUBDOMAIN.workers.dev/health
```

You should see `ok`. If you do, try `/feeds` too — it should return a wall of JSON.

**8.** On the news site, in the calendar card: **Manage** → paste the Worker URL into **Relay URL** → **Save**.

Paste the **base URL only** — no `/calendar`, no trailing slash. The page adds the right path itself.

**9.** Do step 8 again on each device you use (phone, other laptop). The setting is stored per-browser.

---

## What the Worker does once configured

| Endpoint | Used for |
|---|---|
| `/calendar?url=…` | Fetching your calendars. Tried first, ahead of the public relays. |
| `/feeds` | Live news. Used only when `feeds.json` is more than 45 min old, or when you press **Refresh** and it's more than 5 min old. |
| `/health` | Returns `ok`, for checking the deploy. |

Normal page loads **don't touch the Worker at all** for news — they read the committed `feeds.json`, which is why the page loads instantly. The Worker is the safety net.

When news does come from the Worker, the status bar shows `(live)` so you can tell.

### Usage

Cloudflare's free tier is **100,000 requests/day**. Realistic usage here is roughly:

- Calendar: refreshes every 5 min while a tab is open — a few hundred/day per device
- Feeds: only on manual Refresh or if the cron stops — usually zero

You will not get close to the limit. There is no card on file and no way for it to start charging.

### Security

The Worker is on the public internet, so it's locked down rather than being an open proxy:

- **Host allowlist.** Calendar requests only go to Google / Outlook / iCloud domains; feed requests only go to the feed list baked into the Worker. Anything else gets `403`.
- **HTTPS only.** Plain-HTTP targets are rejected.
- **GET only.** Everything else gets `405`.
- **Stores nothing, logs nothing.** It's a pass-through.

Your calendar URL never leaves your browser's local storage — it isn't in the repo, and the Worker doesn't retain it.

One consequence: if you later add a calendar from a provider not on the list (Fastmail, Proton, a university system), you'll get `Host not allowed: …`. That's a one-line fix in `CALENDAR_HOSTS`.

---

## Changing the feed list

The list of news sources appears in **two** files and they must be kept in sync:

- `scripts/fetch-feeds.mjs` — used by the GitHub Action
- `worker/relay.js` — used by the live fallback

Edit both, commit (which triggers a rebuild and redeploy), then re-deploy the Worker by pasting the updated file into the Cloudflare editor.

---

## Troubleshooting

**Calendar says `Host not allowed`**
Your provider isn't in `CALENDAR_HOSTS` in `worker/relay.js`. Add it and redeploy.

**Calendar shows "Tried: … Failed to fetch"**
The Relay URL isn't set, or is wrong. Check **Manage → Relay URL** is the base URL with no trailing slash, and that `/health` returns `ok` in a browser.

**Headlines stuck hours behind**
Check https://github.com/eman5oh/news-discover/actions — the **Build and deploy** schedule may have been auto-disabled after 60 days of repo inactivity, or a run may have failed. Re-enable and run it once by hand. With the Worker configured, pressing **Refresh** gets you current headlines regardless.

**A source shows in the "sources down" count**
Usually temporary — publishers rate-limit or briefly 503. If one stays down for days its feed URL probably moved, and it needs replacing in both files.

**Everything looks stale and nothing helps**
Open your browser console and run `localStorage.clear()`, then reload. That drops all cached headlines, weather, calendars, and your Relay URL — so you'll need to paste the Relay URL in again.
