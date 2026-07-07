# santi's list

Watches Craigslist for new apartment listings that match your saved searches (city, sub-area, neighborhood, keyword, price, bedrooms, bathrooms), verifies the neighborhood against real map data (not just the poster's text label), and alerts you by email — immediately or as an hourly/daily digest, with a one-click link to pause a search from the email itself.

The site is also a browsable, filterable/sortable feed of everything the crawler has found, a map view, and a neighborhood rent map — all independent of notification settings, so anyone can browse without touching what triggers alerts.

Built to be shared with friends without needing real user accounts: browsing and creating saved searches needs no identity at all; a lightweight Profile (just name + email) only gets created the moment someone turns on alerts for a specific search.

## Features

- **Saved searches** — city, Craigslist sub-area (scopes the crawl to just that area, avoiding Craigslist's own recency-window dilution in huge metros), any number of neighborhoods, a free-text keyword filter, price/bed/bath filters; pause/resume any search directly from the Saved Searches list, not just via the emailed one-click link.
- **Alerts are opt-in per search, not global** — creating/editing a saved search needs no identity at all. Turning on "Get email alerts for this search" reveals a name + email field; submitting finds-or-creates a lightweight `Profile` (no password of its own) and attaches it as that search's recipient. A search with no attached profile still crawls and matches (browsable via "Only \<name\>" scope) — it just never emails anyone.
- **Boundary-verified neighborhoods** — a listing only matches a neighborhood if its real coordinates fall inside that neighborhood's official boundary polygon, not just whatever text the poster happened to write. Covers NYC (NTAs), SF Bay Area (SF, Oakland, San Jose real districts + whole-city fallback everywhere else in the East Bay/Peninsula/South Bay), and LA (city neighborhoods + county-wide cities/communities).
- **Listings feed** (`/`) — sortable by newest, price, distance to train, or commute time; filterable by neighborhood, keyword, and train line; price is colored against the real median rent for that listing's neighborhood + bedroom count (green well below median, yellow at median, red well above), not just a gradient over whatever's on screen.
- **Rent Map** (`/rent-map`) — a choropleth of every neighborhood in a city, colored by median rent for a selected bedroom count (green cheapest, red priciest, yellow the median neighborhood), using the same real boundary polygons as the rest of the app.
- **Map view** (`/map`) — listings plotted by location, transit stations colored by line, your work address marked with a star; listings older than 30 days fade toward a floor (the white outline always stays fully solid so nothing becomes unclickable); listings sharing the exact same coordinates (e.g. multiple units in one building) collapse into a single marker showing the count, with a combined popup; reports how many crawled listings couldn't be plotted for lack of a location, scoped to whatever saved search(es) are currently selected.
- **Commute times** — by car and bike via free OSRM routing (a separate dedicated instance for bike — the same OSRM demo server silently reuses its driving graph for "bike" otherwise), and by transit via a free straight-line estimate by default. Real routing via Google's Directions API is available but **off by default** and password-gated to turn on (see below) since it costs money past Google's free tier; every real (non-heuristic) commute lookup is cached by listing+mode+work-location so repeated sorts/page views/map opens don't re-request the same route.
- **Google Directions is opt-in and cost-protected** — `Settings.useGoogleDirections` defaults to `false` regardless of whether `GOOGLE_MAPS_API_KEY` is configured; turning it on from `/settings` requires re-entering the app password as a deliberate extra confirmation step, since it's the one setting here with a real dollar cost.
- **Notifications** — immediate per-match email, or hourly/daily digests, sent to whichever Profile a search's alerts are attached to; every email includes a one-click "pause this search" link that needs no login.
- **Settings** (`/settings`) — deployment-wide work address (fallback commute origin, geocoded with autocomplete confirmation), the Google Directions toggle, light/dark/system theme, and a "clear cache & re-crawl" maintenance action.
- **Weekly full-city crawl** — independent of any saved search, crawls every subarea of every supported city once a week with no price/bed/bath filter, to keep browsing and the Rent Map populated beyond whatever active watches happen to cover. Off-peak by default (`FULL_CRAWL_HOUR`/`FULL_CRAWL_DAY_OF_WEEK`); shares the regular crawl's lock so the two never race on the same rows. A "Force full-city crawl" button on Saved Searches runs it on demand (e.g. to seed the Rent Map immediately instead of waiting for the schedule) — expect it to take several minutes.
- **Old listings get deleted, not just hidden** — a daily job (`PRUNE_HOUR`) permanently removes any listing older than ~1 month (by posted/renewed date, falling back to when the crawler first saw it), and a confirmed-gone listing (Craigslist itself returns 404/410) is deleted immediately rather than left stale. Keeps the Rent Map's medians from being skewed by long-expired listings. A renewed listing (Craigslist shows an "updated:" date past the original "posted:" one) is treated as freshly posted as of that renewal, so it won't get pruned just because it was first listed a while ago.
- **Live crawl status** (top-right nav) — a progress bar while a crawl is running; otherwise "Data as of {time}", derived from the most recently-seen listing so it stays accurate across server restarts (crawl-cycle results themselves are only kept in memory).
- **Optional password gate** — set `APP_PASSWORD` to require a login before anyone can use the site at all.

## Local development (Homebrew Postgres)

1. Install Postgres and start it:
   ```bash
   brew install postgresql@16
   brew services start postgresql@16
   createdb craigslist_watch
   ```
2. Copy `.env.example` to `.env` and fill in at least `DATABASE_URL` (e.g. `postgresql://<your-macos-username>@localhost:5432/craigslist_watch?schema=public`) and an email provider (`RESEND_API_KEY`, or `SMTP_URL` + `EMAIL_FROM`). Everything else in `.env.example` is optional — see comments there for what each one does.
3. Install dependencies and set up the database:
   ```bash
   npm install
   npx prisma migrate dev
   ```
4. (Optional) seed an example saved search:
   ```bash
   npm run seed
   ```
5. Run the app:
   ```bash
   npm run dev
   ```
   Open http://localhost:3000. The crawler + digest scheduler start automatically in-process (see `src/instrumentation.ts` / `src/server/scheduler.ts`).

### Starting/stopping the dev server

```bash
# start it in the foreground (Ctrl+C to stop)
npm run dev

# or start it in the background, logging to a file
nohup npm run dev > /tmp/santislist-dev.log 2>&1 &

# stop a background instance
pkill -f "next dev"
```

If it ever hangs or crashes, `pkill -f "next dev"` then re-run `npm run dev` — Turbopack's dev cache lives in `.next/`, so deleting that directory (`rm -rf .next`) first can help if it's stuck on a corrupted cache.

### Useful scripts

- `npm run crawl:once` — run one crawl cycle immediately (useful for testing a new saved search without waiting for the schedule).
- `npm run crawl:full-city-once` — run the weekly full-city backfill crawl immediately.
- `npm run digests:once` — force an hourly + daily digest flush immediately.
- `npm run backfill:geo` — backfill bedrooms/bathrooms/coordinates for listings that predate that enrichment.
- `npm run backfill:boundary-neighborhood` — backfill `Listing.boundaryNeighborhood` for listings that have coordinates but predate that column (one-time, after pulling a schema update that adds it).
- `npm run prune:once` — force the daily "delete listings older than ~1 month" job immediately.
- `npx prisma studio` — browse/edit the database in a GUI (also how you'd manage `Profile` rows today — there's no admin UI for that yet).

### Managing who's signed up for alerts

There's no admin UI for this yet — a `Profile` (name + email) is created automatically the first time someone turns on alerts for a saved search, and that's the only "account" concept in the app. To see or change who's signed up, go straight to the database:

- **Prisma Studio** (works locally or pointed at a production `DATABASE_URL`): `npx prisma studio`, then open the `Profile` table. Each row is one person; their linked `Watch` rows show what they're getting alerted on.
- **Raw SQL**, e.g. via `psql` or Railway's dashboard query tool:
  ```sql
  -- Everyone currently signed up for alerts, and what they're watching
  SELECT p.name, p.email, w.name AS watch_name, w."notifyFrequency"
  FROM "Profile" p
  JOIN "Watch" w ON w."profileId" = p.id;

  -- Remove someone's alerts entirely
  DELETE FROM "Profile" WHERE email = 'someone@example.com';
  ```
  Deleting a `Profile` doesn't delete their saved searches — `Watch.profileId` is set to `NULL` (`onDelete: SetNull`), so the search keeps crawling/matching for browsing, it just stops emailing anyone.

## Running with Docker Compose

```bash
cp .env.example .env   # fill in email provider vars
docker compose up --build
```

Runs the app + Postgres together; `docker-entrypoint.sh` applies Prisma migrations on container start.

## Deploying

A single Next.js container plus a Postgres database — deployable to Railway, Fly.io, or any host that runs a Docker image and provisions Postgres. All configuration is via environment variables (`.env.example`); nothing assumes `localhost` networking or local-filesystem persistence outside the database and the small on-disk cache in `.cache/` (safe to lose — it just gets re-fetched).

Two things that matter specifically for hosted deploys:

- **Don't use a serverless/edge host** (e.g. Vercel) — the crawler and digest scheduler run as an in-process `node-cron` job (`src/instrumentation.ts`) that needs a long-running container, not a request-scoped function.
- **`next start` needs `$PORT`** — most PaaS hosts (Railway, Heroku, etc.) assign a port dynamically via a `PORT` env var and route traffic only to that port. `package.json`'s start script already handles this (`next start -p ${PORT:-3000}`); nothing to do unless you're customizing further.

Set `APP_URL` to your deployed origin if you want the "pause this search" link in emails to work (it's used to build an absolute URL from a cron tick, which has no request to derive one from).

**Run migrations on every deploy.** Set your host's start command to `npx prisma migrate deploy && npm start` (Railway: Settings → Deploy → Start Command) rather than just `npm start`. `prisma migrate deploy` only applies migrations that haven't run yet and is safe to run on every boot — without it, a deploy that includes a schema change will crash the moment the new code hits a database that's still on the old schema.

## How it works

- **Saved searches** (`/watches`) define what gets crawled: city, optional Craigslist sub-area(s), neighborhoods, keyword, and price/bedroom/bathroom filters. Turning on alerts for a search additionally attaches a `Profile` (name + email, found-or-created by email) as the recipient and sets a notification frequency — a search with no attached profile still crawls/matches, it just never emails.
- **Crawler** (`src/server/crawl`) searches Craigslist once per sub-area (or once for the whole city if none are set) every ~20 minutes, dedupes listings by their Craigslist URL token, and — only for genuinely new listings — fetches the individual listing page to backfill bedrooms/bathrooms/posted date/coordinates/neighborhood. A separate **weekly full-city crawl** (same underlying dedup/enrichment logic, factored into `resolveListings`) does the same thing for every subarea of every supported city with no price filter, independent of any saved search, to keep browsing/the Rent Map populated beyond what active watches cover — it shares the regular crawl's in-progress lock so the two can't race on the same rows, and never does watch-matching or notifications (so no commute/station-distance lookups happen there).
- **Neighborhood matching** (`src/server/geo/neighborhoodBoundaries.ts`) checks a listing's real coordinates against official boundary polygons (NYC NTAs; SF + Oakland + San Jose real districts plus a whole-city fallback for the rest of the East Bay/Peninsula/South Bay via CDTFA's statewide layer; LA City neighborhoods + county-wide cities/communities) rather than trusting Craigslist's own free-text search, which breaks for boundary names real posters never write (e.g. "Bushwick (East)"). The result is persisted on `Listing.boundaryNeighborhood` at crawl time (not recomputed per request) specifically so median-rent stats can `GROUP BY` it in SQL for the feed's price coloring and the Rent Map.
- **Notifications** (`src/server/notify`) send one email per saved search per crawl cycle in immediate mode, or batch unsent matches into a periodic digest, to whichever `Profile` the search has alerts attached to (skipped entirely if none); every email includes a per-watch "pause this search" link authorized by an HMAC token, not the site password.
- **Listings feed** (`/`), **map** (`/map`), and **Rent Map** (`/rent-map`) are independent, filterable/sortable browse views over everything the crawler has found — they don't require or depend on any search having alerts configured.
- **Commute times** (`src/server/geo/commute.ts`) — car and bike via free OSRM routing instances, transit via a free straight-line estimate built from existing nearest-station data by default; real routing via Google's Directions API only when both `GOOGLE_MAPS_API_KEY` is set *and* `Settings.useGoogleDirections` is on (see Features above). Real (non-heuristic) results are cached by listing+mode+work-location (`CommuteCache`) so repeated requests don't re-spend either the free routing servers' patience or Google's quota.
