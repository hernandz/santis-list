# santi's list

Crawls Craigslist for new apartment listings matching your saved searches (city, neighborhood, price, bedrooms, bathrooms) and alerts you by email — immediately or as an hourly/daily digest. The site itself is also a browsable feed of everything the crawler has found.

## Local development (Homebrew Postgres)

1. Install Postgres and start it:
   ```bash
   brew install postgresql@16
   brew services start postgresql@16
   createdb craigslist_watch
   ```
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL` (e.g. `postgresql://<your-macos-username>@localhost:5432/craigslist_watch?schema=public`) and an email provider (`RESEND_API_KEY` or `SMTP_URL` + `NOTIFY_TO_EMAIL`).
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

From the project root (`/Users/santos/dev/santis-list`):

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

Once Docker is installed:

```bash
cp .env.example .env   # fill in email provider vars
docker compose up --build
```

This runs the app + Postgres together; `docker-entrypoint.sh` applies Prisma migrations on container start.

## Deploying

The app is a single Next.js container plus a Postgres database — deployable to Fly.io, Railway, or any host that can run a Docker image and provision Postgres. All configuration is via environment variables (see `.env.example`); nothing assumes `localhost` networking or local-filesystem persistence outside the database.

## How it works

- **Saved searches** (`/watches`) define what gets crawled: Craigslist city + optional sub-area, neighborhood keyword, price/bedroom/bathroom filters, and how you want to be notified (immediate, hourly digest, or daily digest).
- **Crawler** (`src/server/crawl`) polls Craigslist's search-results page for each active saved search, matches on neighborhood keyword, dedupes listings by their Craigslist URL token, and fetches the individual listing page (bounded to just new matches) to fill in bedrooms/bathrooms/posted date.
- **Notifications** (`src/server/notify`) send a single email per saved search per crawl cycle (immediate mode) or batch unsent matches into a periodic digest.
- **Listings feed** (`/`) is a filterable/sortable browse view over everything the crawler has found, independent of the notification settings.
