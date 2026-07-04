# santi's list

Watches Craigslist for new apartment listings that match your saved searches (city, sub-area, neighborhood, price, bedrooms, bathrooms), verifies the neighborhood against real map data (not just the poster's text label), and alerts you by email — immediately or as an hourly/daily digest, with a one-click link to pause a search from the email itself.

The site is also a browsable, filterable/sortable feed of everything the crawler has found, plus a map view — both independent of the notification settings, so you can casually browse without touching what triggers alerts.

## Features

- **Saved searches** — city, Craigslist sub-area (scopes the crawl to just that area, avoiding Craigslist's own recency-window dilution in huge metros), any number of neighborhoods, price/bed/bath filters, notification frequency.
- **Boundary-verified neighborhoods** — a listing only matches a neighborhood if its real coordinates fall inside that neighborhood's official city GIS polygon, not just whatever text the poster happened to write.
- **Listings feed** (`/`) — sortable by newest, price, distance to train, or commute time; a red→green color gradient on price/train/commute columns scaled to what's on screen.
- **Map view** (`/map`) — listings plotted by location, transit stations colored by line, your work address marked with a star, older listings fade out, and it reports how many crawled listings couldn't be plotted for lack of a location.
- **Commute times** — by car (OSRM), by bike (a separate dedicated bike-routing instance — the same OSRM demo server silently reuses its driving graph for "bike" otherwise), and by transit (Google Directions if `GOOGLE_MAPS_API_KEY` is set, else a free straight-line estimate).
- **Notifications** — immediate per-match email, or hourly/daily digests; every email includes a one-click "pause this search" link that needs no login.
- **Settings** (`/settings`) — alert email, work address (geocoded, with autocomplete confirmation), light/dark/system theme, and a "clear cache & re-crawl" maintenance action.
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
- `npm run digests:once` — force an hourly + daily digest flush immediately.
- `npx prisma studio` — browse/edit the database in a GUI.

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

## How it works

- **Saved searches** (`/watches`) define what gets crawled: city, optional Craigslist sub-area(s), neighborhoods, price/bedroom/bathroom filters, and notification frequency.
- **Crawler** (`src/server/crawl`) searches Craigslist once per sub-area (or once for the whole city if none are set) every ~20 minutes, dedupes listings by their Craigslist URL token, and — only for genuinely new listings — fetches the individual listing page to backfill bedrooms/bathrooms/posted date/coordinates.
- **Neighborhood matching** (`src/server/geo/neighborhoodBoundaries.ts`) checks a listing's real coordinates against official city GIS boundary polygons (NYC NTAs, SF analysis neighborhoods, LA City neighborhoods + county-wide cities/communities) rather than trusting Craigslist's own free-text search, which breaks for boundary names real posters never write (e.g. "Bushwick (East)").
- **Notifications** (`src/server/notify`) send one email per saved search per crawl cycle in immediate mode, or batch unsent matches into a periodic digest; every email includes a per-watch "pause this search" link authorized by an HMAC token, not the site password.
- **Listings feed** (`/`) and **map** (`/map`) are independent, filterable/sortable browse views over everything the crawler has found — they don't require or depend on notifications being configured.
- **Commute times** (`src/server/geo/commute.ts`) — car and bike via free OSRM routing instances, transit via Google's Directions API when a key is configured, otherwise a straight-line estimate built from existing nearest-station data.
