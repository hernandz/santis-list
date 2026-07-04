# How this app works (for someone who knows JS/Python, not Node.js)

This walks through the stack from the ground up, translating each Node.js/Next.js/React concept into something you already know. If a section doesn't apply to you, skip it — it's ordered roughly bottom-up (runtime → framework → this app's code).

## 1. Node.js, in terms you already know

**Node.js is just a JS runtime that isn't a browser.** Same JavaScript language you already know (same syntax, same `Array.map`, same `async`/`await`) — but instead of a DOM and a `window` object, it gives you filesystem access, TCP sockets, `process.env`, and so on. Think of it the way you'd think of CPython vs. a JS engine embedded in a browser tab: same language, different host environment exposing different APIs.

- **`package.json`** is `pyproject.toml` + `requirements.txt` combined — it lists dependencies (`dependencies`/`devDependencies`) and named scripts (`npm run dev`, `npm run build`) the way you'd have console-script entry points or a `Makefile`.
- **`node_modules/`** is the JS equivalent of a `venv/` — except by default it's per-project only (no global "activate" step; running `npm install` inside a project directory is enough, and any command run via `npm run` or `npx` automatically resolves into that local folder first).
- **`npm install <pkg>`** ≈ `pip install <pkg>`. **`npx <tool>`** ≈ running a tool from your venv's `bin/` without necessarily having installed it as a project dependency (e.g. `npx prisma migrate dev` in a one-off way).
- **TypeScript** is JS + static types (think: JS with mypy-style annotations baked into the syntax, not a separate checker bolted on). It compiles down to plain JS before running; Next.js does this transparently in this project, so you never manually run a `tsc` build step during development.
- **The event loop.** Node is single-threaded but non-blocking, similar in spirit to Python's `asyncio` — except in Node, *everything* I/O-related (HTTP requests, database queries, file reads) is async by default, not an opt-in library choice. You'll see `async function` and `await` constantly in this codebase; that's not a stylistic choice, it's just how you do I/O in Node. There's no GIL-vs-threading question to reason about here — concurrency within one Node process is entirely "one thing runs at a time, but nothing blocks while waiting on I/O," much like a single-threaded `asyncio` event loop.
- **ES modules.** This project uses `import`/`export` (not the older `require`/`module.exports` you may see in older Node tutorials) — directly analogous to Python's `import`/`from x import y`.

## 2. Next.js: what it actually is

Next.js is a framework that gives you, in one project: a web server, file-based routing for both pages and API endpoints, and a build pipeline — roughly "Flask/Django + a bundler + React templating," packaged together. There is no separate frontend build step and backend server to run independently; `npm run dev` starts one process that serves both.

### File-based routing

Every route is a folder + a file, under `src/app/`:

| File | Route | Analogy |
|---|---|---|
| `src/app/page.tsx` | `GET /` | your root view function |
| `src/app/watches/page.tsx` | `GET /watches` | `@app.route("/watches")` |
| `src/app/watches/[id]/page.tsx` | `GET /watches/abc123` | `@app.route("/watches/<id>")` |
| `src/app/api/listings/route.ts` | `/api/listings` | a Flask/FastAPI view module |

Inside a `route.ts` file (an **API route**), you export functions named after HTTP verbs — `export async function GET(request) {...}`, `export async function POST(request) {...}` — each one is literally the handler for that verb on that path, the same shape as a FastAPI path operation function, just grouped by file instead of by decorator.

`page.tsx` files are different: they're not handlers you write imperatively, they're **React components** (see §3) that Next.js renders into HTML automatically. There's no `render_template()` call anywhere — the component *is* the template, and Next.js handles turning it into an HTTP response.

### Server Components vs. Client Components

This is the one genuinely unfamiliar concept if you've only done Flask/Django + vanilla JS, or plain React.

By default, every component in `src/app/` is a **Server Component**: it runs on the server, generates HTML, and ships *only that HTML* to the browser — no JavaScript for that component is sent to the client at all. Think of it like a Jinja2/Django template that happens to be written as a JS function instead of a `.html` file with `{{ }}` tags.

A file that starts with `"use client"` (you'll see this at the top of most files in this project, e.g. `src/app/page.tsx`, `src/app/settings/page.tsx`) is a **Client Component**: it *does* ship its JavaScript to the browser and becomes a normal interactive React component there — state, click handlers, `fetch()` calls, all of it. This project's browsing UI (the feed, the map, the forms) is almost entirely client components, because they need interactivity (dropdowns, live filtering, a Leaflet map). The `layout.tsx` shell (nav bar) and most of the API routes' surrounding plumbing are server-side.

Rule of thumb while reading the code: no `"use client"` at the top → it only ever runs on the server, and can safely import server-only things (Prisma, `fs`, secrets). `"use client"` present → assume it runs in the visitor's browser and can't touch anything server-side directly (it has to `fetch()` an API route instead).

### `proxy.ts` — a request gatekeeper

`src/proxy.ts` runs before *every* matching request, server-side, before any page or API route handler executes. It's the same concept as Flask's `before_request` hook or a WSGI/ASGI middleware layer. This project uses it for exactly one thing: checking the login cookie and redirecting to `/login` (or returning a 401 for API calls) if you haven't authenticated and `APP_PASSWORD` is set.

(Historically this file convention was called `middleware.ts` — Next.js renamed it to `proxy.ts` recently; you may see the old name in older tutorials/StackOverflow answers.)

## 3. React, the parts this app actually uses

A React **component** is just a function that returns JSX (HTML-looking syntax embedded directly in JS/TS — `<div className="...">{someVariable}</div>`). JSX isn't a template string; it compiles into regular function calls that build a tree of objects describing the UI, which React then turns into real DOM.

Two hooks show up everywhere in this codebase:

- **`useState`** — a piece of component-local state. `const [scope, setScope] = useState(ALL_WATCHES_SCOPE)` declares a variable *and* a setter; calling the setter schedules a re-run of the component function with the new value baked in — there's no manual "re-render the DOM" step, React just re-executes the function and diffs the result. Think of it as an instance attribute that automatically re-invokes `render()` whenever you mutate it through its accessor.
- **`useEffect`** — "run this after the component renders, and optionally again when these specific values change." This project uses it almost exclusively for data fetching: `useEffect(() => { fetch("/api/watches")... }, [])` means "on mount, go fetch the list of watches" — the empty `[]` dependency array means "only run once." You'll see this pattern dozens of times (`src/app/page.tsx`, `src/app/map/page.tsx`, etc.) — it's the client-side equivalent of an `onload` handler making an AJAX call.

There's no ORM-style two-way data binding — every `<input>` you see explicitly wires `value={state}` and `onChange={e => setState(e.target.value)}` by hand; that verbosity is deliberate/idiomatic React, not something missing.

## 4. The database layer: Prisma

Prisma is the SQLAlchemy/Django-ORM equivalent here, with one structural difference: instead of defining tables as Python classes, you define them in a separate schema file, `prisma/schema.prisma`, using Prisma's own small schema language:

```prisma
model Watch {
  id            String   @id @default(cuid())
  name          String
  city          String
  neighborhoods String[]
  minPrice      Int?
  ...
}
```

From that file, `npx prisma generate` produces a fully-typed JS/TS client (checked into `src/generated/prisma/` in this project) that you import and query against:

```ts
const watch = await prisma.watch.findUnique({ where: { id } });
await prisma.watch.update({ where: { id }, data: { isActive: false } });
```

That's the same shape as `session.query(Watch).filter_by(id=id).first()` / Django's `Watch.objects.get(id=id)` — just async (`await`) because everything I/O-bound in Node is async.

**Migrations** (`prisma/migrations/`) work like Alembic/Django migrations: `npx prisma migrate dev` diffs your schema file against the current migration history, generates a new SQL migration file, and applies it. `npx prisma studio` is a free GUI for browsing/editing rows directly (think pgAdmin, but auto-generated from your schema).

## 5. The crawler and scheduler

- **`node-cron`** is this project's APScheduler-equivalent: `cron.schedule("*/20 * * * *", runCrawlCycle)` runs a function on a cron-style schedule, in-process, in the same running Node process as the web server (not a separate OS-level cron job or worker process).
- **`src/instrumentation.ts`** is a special Next.js file that runs exactly once, when the server process boots — the closest analogy is a Flask app factory's one-time setup code, or Django's `AppConfig.ready()`. This project uses it to call `register()` in `src/server/scheduler.ts`, which sets up the cron jobs.
- **The actual scraping** (`src/server/crawl/sources/craigslist.ts`) is plain `fetch()` + Cheerio — Cheerio is a server-side jQuery-like API for parsing and querying static HTML, the direct equivalent of Python's BeautifulSoup. No headless browser is involved; Craigslist's no-JS fallback HTML is enough.
- **Politeness/rate limiting** (`src/server/rateLimiter.ts`) and a circuit breaker in `craigslist.ts` throttle and back off requests — conceptually the same as what you'd build with `time.sleep` + a failure counter in a Python scraper, just wrapped around every outgoing `fetch()`.

One crawl cycle, end to end: for each active saved search, fetch Craigslist's search-results HTML for that search's sub-area(s) → parse out title/price/URL per listing with Cheerio → dedupe against the DB by the listing's URL token → for genuinely new listings, fetch that listing's own detail page to backfill bedrooms/bathrooms/coordinates → check the coordinates against real neighborhood boundary polygons (`src/server/geo/neighborhoodBoundaries.ts`) → if it matches the search's criteria, record a match and (depending on notification frequency) send or queue an email.

## 6. Directory tour

```
src/
  app/                    # routes — one folder per URL path (see §2)
    page.tsx              # "/" — the listings feed (client component)
    watches/              # "/watches" — saved search management
    map/                  # "/map" — map view
    settings/             # "/settings"
    login/                # "/login"
    api/                  # every subfolder here is an API endpoint, not a page
  components/             # shared React components (client-side UI bits)
  lib/                    # small, framework-agnostic helper modules
  server/                 # server-only code — never sent to the browser
    crawl/                # the Craigslist scraper + crawl cycle orchestration
    notify/               # email sending + digest batching
    geo/                  # neighborhood boundaries, transit stations, commute calc
    db/                   # the Prisma client singleton
  generated/prisma/       # auto-generated by `prisma generate` — don't hand-edit
  instrumentation.ts      # runs once at server boot (starts the scheduler)
  proxy.ts                # runs before every request (the login gate)
prisma/
  schema.prisma           # the data model, in Prisma's schema language
  migrations/             # one folder per applied migration, like Alembic
scripts/                  # one-off scripts run via `npx tsx scripts/foo.ts`
```

## 7. A concrete request, start to finish

Loading `/` in a browser with the password gate enabled:

1. Request hits the Node process. `src/proxy.ts` runs first, checks for a valid `app_auth` cookie; if missing, responds with a redirect to `/login` and nothing else runs.
2. With a valid cookie: Next.js matches `/` to `src/app/page.tsx`, which is a **Client Component** (`"use client"` at the top) — so what actually gets sent to the browser first is a mostly-empty shell plus the compiled JS bundle for that component.
3. The browser loads that JS, React mounts the component, and its `useEffect` hooks fire — one of them calls `fetch("/api/listings?...")`.
4. That request hits `src/app/api/listings/route.ts`'s exported `GET` function, which builds a Prisma query (city/price/neighborhood filters, live boundary-polygon checks, optional commute-time lookups), awaits the result, and returns `NextResponse.json(...)`.
5. The browser's `fetch()` resolves, `setState()` is called with the results, and React re-renders the component function with real data — same purely-in-browser update cycle as any SPA you've built, it just happens to be served from the same Next.js process that rendered the initial shell.
