# Network Map Provider Feeder

Render dashboard and Scrapy-capable crawler ingestion service for the Network Map provider database.

This repo no longer uses the old Bing/Google/Apple HTML map parser. The old map worker loop and source-policy files have been removed. Provider growth now comes from Scrapy crawlers that extract clinic/location/provider rows from configured public directory pages and write them into Neon.

## Current shape

- Runtime: Docker web service with Node dashboard and Python/Scrapy runtime installed.
- Deployment target: Render web service.
- Primary ingestion: Scrapy crawler configs under `scrapers/`.
- Database: existing Neon Postgres database.
- Final output: `provider_candidates`.
- Staging/dedupe: `provider_feeder_candidates`.
- Raw/source evidence: `google_maps_raw_results` with `raw.source = scrapy_directory` for crawler rows.
- UI: built-in dashboard served from `/` and `/dashboard`.
- Health/API endpoints: `/health`, `/healthz`, `/status`, `/api/dashboard`.

## Current flow

```text
clinic directory pages / location pages
→ Scrapy spider extracts provider rows
→ google_maps_raw_results
→ provider_feeder_candidates
→ provider_candidates
```

## What the Render web service does

1. Starts the dashboard and health endpoints.
2. Bootstraps feeder-owned Neon tables when enabled.
3. Validates required Neon tables.
4. Shows app candidates, staging candidates, raw rows, current Scrapy source counts, and separated legacy source counts.

It does **not** run the old map job queue anymore.

## What Scrapy does

The crawler layer lives in `scrapers/`.

It can:

- crawl configured clinic/location directory pages;
- extract name, address, city, state, ZIP, phone, website, services, source URL, and optional coordinates;
- clean required fields;
- write raw source rows;
- upsert feeder staging rows;
- upsert final app-facing rows into `provider_candidates`.

Scrapy writes to Neon only when:

```env
SCRAPY_WRITE_TO_NEON=1
```

## Required tables

| Table | Purpose |
|---|---|
| `google_maps_raw_results` | Raw crawler/source evidence rows. Name is legacy, but still used as the raw table. |
| `provider_feeder_candidates` | Staging/dedupe rows. Not the final app output. |
| `provider_candidates` | Final app-facing provider candidates. Inspected dynamically. |
| `provider_feeder_jobs` | Legacy map-job table retained for compatibility/history. Not used by the current worker loop. |
| `provider_feeder_candidate_sources` | Legacy/source-link table retained for compatibility/history. |
| `provider_feeder_runs` | Legacy run-history table retained for compatibility/history. |

## Dashboard routes

| Route | Purpose |
|---|---|
| `/` | Dashboard UI. |
| `/dashboard` | Dashboard UI. |
| `/api/dashboard` | Dashboard data as JSON. |
| `/health` | Machine-readable health check. |
| `/healthz` | Machine-readable health check. |
| `/status` | Machine-readable status check. |

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `DATABASE_URL` | — | Neon connection string. Required. |
| `ENABLE_SCHEMA_BOOTSTRAP` | `1` | Create/maintain feeder-owned tables when enabled. |
| `VALIDATE_SCHEMA_ON_START` | `1` | Validate required feeder tables on startup. |
| `ENABLE_APP_CANDIDATE_WRITE` | `1` | Upsert final app-facing rows into `APP_CANDIDATE_TABLE`. |
| `APP_CANDIDATE_TABLE` | `provider_candidates` | Final app-facing provider table; inspected dynamically. |
| `SCRAPY_WRITE_TO_NEON` | `0` | When set to `1`, Scrapy crawler rows are written into Neon. |
| `DASHBOARD_SHOW_LEGACY` | `0` | Show legacy map jobs/errors in dashboard. |

## Commands

| Command | Purpose |
|---|---|
| `npm run worker` | Start the Render dashboard/health service. |
| `npm run smoke` | Verify database connection and required feeder tables. |
| `npm run crawl:clinic -- -a config=sources/my-source.json` | Run the config-driven Scrapy clinic directory crawler from `scrapers/`. |
| `npm run check` | Syntax-check the Node files. |

## Running a crawler

From a shell with the repo checked out and `DATABASE_URL` set:

```bash
cd scrapers
SCRAPY_WRITE_TO_NEON=1 scrapy crawl clinic_directory -a config=sources/my-source.json -O output/my-source.jsonl
```

The source config defines the target page and selectors. See `scrapers/README.md`.

## Deleted old path

The old path has been removed from code:

```text
src/scraper.js
src/sourcePolicy.js
src/jobSeeder.js
src/normalize.js
scripts/check-source-policy.js
scripts/seed-jobs.js
```

The current repo direction is:

```text
Render dashboard + Scrapy crawler ingestion + Neon final provider output
```
