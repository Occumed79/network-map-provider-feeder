# network-map-provider-feeder

A **standalone feeder service** for the [Network Map](https://github.com/Occumed79) project. It runs controlled Google Maps extraction jobs, stores raw results, normalizes/deduplicates them into provider candidates, and writes everything to the **same Neon Postgres database** used by Network Map.

> **This is a separate repository.** It does NOT modify or depend on the Network Map frontend. Network Map can later read the `provider_candidates` table to merge enriched provider data.

## Architecture

```
Google Maps scraper (gosom/google-maps-scraper)
        ↓
  feeder worker (this repo)
        ↓
  Neon Postgres (shared DATABASE_URL)
    ├── google_maps_raw_results   (raw scraper output)
    ├── provider_candidates       (normalized, deduped)
    └── provider_candidate_sources (link table)
        ↓
  Network Map reads provider_candidates (later, separately)
```

## What this service does

- Polls `provider_feeder_jobs` for pending jobs
- Runs `gosom/google-maps-scraper` in Docker for each job's query
- Imports raw JSON results into `google_maps_raw_results`
- Normalizes phone, website, name, lat/lon
- Deduplicates into `provider_candidates` by:
  1. `google_place_id`
  2. `google_cid`
  3. Normalized phone
  4. Normalized website domain
  5. Normalized name + address
  6. Nearby lat/lon + similar name (fuzzy)
- Marks each job completed or failed

> **Important:** This is a **controlled, targeted enrichment** service. It only processes jobs that are explicitly seeded or queued. It does NOT perform uncontrolled national brute-force crawling.

## Prerequisites

- Node.js 18+
- Docker (for running the Google Maps scraper)
- A Neon Postgres database (the same one used by Network Map)

## Quick start

```bash
# 1. Clone
git clone https://github.com/Occumed79/network-map-provider-feeder.git
cd network-map-provider-feeder

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and set DATABASE_URL to your Neon connection string

# 4. Run migrations (creates tables in Neon)
npm run migrate

# 5. Verify database connectivity and tables
npm run smoke

# 6. Seed test jobs (small controlled batch)
npm run seed

# 7. Start the worker
npm run worker
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Neon Postgres connection string (required) | — |
| `DISABLE_TELEMETRY` | Disable scraper telemetry | `1` |
| `MAX_JOBS_PER_LOOP` | Max jobs claimed per poll cycle | `1` |
| `WORKER_POLL_INTERVAL_MS` | Milliseconds between polls when idle | `30000` |
| `DEFAULT_CONCURRENCY` | Scraper concurrency (`-c` flag) | `1` |
| `SCRAPER_IMAGE` | Docker image for the scraper | `gosom/google-maps-scraper` |
| `SCRAPER_TIMEOUT_MS` | Scraper process timeout in ms | `300000` |

## NPM scripts

| Command | Description |
|---|---|
| `npm run migrate` | Run SQL migrations against Neon |
| `npm run seed` | Insert a small test batch of jobs |
| `npm run worker` | Start the background worker |
| `npm run smoke` | Verify DB connectivity and table existence |

## Database tables created

| Table | Purpose |
|---|---|
| `provider_feeder_jobs` | Job queue: query, status, attempts, priority |
| `google_maps_raw_results` | Raw scraper output per job |
| `provider_candidates` | Normalized, deduplicated provider records |
| `provider_candidate_sources` | Links candidates to raw source rows |
| `provider_feeder_runs` | Per-job run log with counts and status |

## Verifying data landed in Neon

After running the worker on at least one job:

```sql
-- Check job statuses
SELECT id, query, status, attempts, created_at, completed_at
FROM provider_feeder_jobs ORDER BY id;

-- Check raw results
SELECT count(*) FROM google_maps_raw_results;

-- Check normalized candidates
SELECT id, name, country_code, confidence_score, status, dedupe_key
FROM provider_candidates ORDER BY confidence_score DESC LIMIT 20;

-- Check run history
SELECT * FROM provider_feeder_runs ORDER BY id DESC LIMIT 10;
```

## Deploy on Render

1. Create a new **Background Worker** service on [Render](https://render.com).
2. Connect this GitHub repository.
3. Set the build command: `npm install`
4. Set the start command: `npm run worker`
5. Add environment variable `DATABASE_URL` (your Neon connection string) in the Render dashboard.
6. Add `DISABLE_TELEMETRY=1`.
7. Deploy.

Alternatively, use the included `render.yaml` with Render Blueprints.

> **Note:** The worker needs Docker access to run the scraper. On Render, you may need to use a Docker-based deployment or a custom start command that runs the scraper binary directly. See [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) for binary options.

## Running with Docker Compose

```bash
cp .env.example .env
# Set DATABASE_URL in .env
docker compose up --build
```

This mounts the Docker socket so the worker can spawn scraper containers.

## Local development

```bash
npm install
cp .env.example .env
# Set DATABASE_URL
npm run migrate
npm run smoke
npm run seed
npm run worker
```

The worker will poll for jobs, run the scraper in Docker, import results, and normalize candidates. Watch the console logs for progress.

## Intentionally left for later

- Geo/radius-based scraper queries (currently query-string only)
- Multiple country support beyond US defaults
- Web UI or API for job management
- Scheduled/automated job creation
- Scraper binary mode (non-Docker) for Render
- Candidate merging workflow (Network Map side)
- Rate limiting / throttling between jobs
- Email/Slack notifications on failures
