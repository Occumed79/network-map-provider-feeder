# Network Map Provider Feeder

Render-deployable feeder service for the Network Map provider database.

This service continuously claims provider search jobs, runs parallel mapped-source lookups, stores raw mapped results, normalizes/deduplicates provider candidates, and exposes a small dashboard from the same web service.

## Current shape

- Runtime: lightweight Node Docker service.
- Deployment target: Render web service.
- Sources: parallel mapped HTTP lookups from Bing Maps, Google Maps, and Apple Maps.
- Database: existing Neon Postgres database.
- UI: built-in dashboard served from `/` and `/dashboard`.
- Health/API endpoints: `/health`, `/healthz`, `/status`, `/api/dashboard`.

## What this service does

1. Starts a small HTTP server for the dashboard and health checks.
2. Validates the required Neon feeder tables without changing schema.
3. Resets stale running jobs after deploys/restarts.
4. Seeds targeted provider-search jobs when the queue is low.
5. Claims pending jobs one at a time by default.
6. Runs enabled mapped sources in parallel for each job.
7. Merges/dedupes source results.
8. Writes raw rows to `google_maps_raw_results`.
9. Writes normalized rows to `provider_feeder_candidates`.
10. Links candidate/source rows in `provider_feeder_candidate_sources`.
11. Records run history in `provider_feeder_runs`.

## Architecture

```text
Render web service
  ├─ Dashboard: / and /dashboard
  ├─ Health/API: /health, /status, /api/dashboard
  └─ Worker loop
       ├─ provider_feeder_jobs
       ├─ Bing Maps HTTP lookup
       ├─ Google Maps HTTP lookup
       ├─ Apple Maps HTTP lookup
       ├─ google_maps_raw_results
       ├─ provider_feeder_candidates
       ├─ provider_feeder_candidate_sources
       └─ provider_feeder_runs
```

## Neon schema guardrail

This repo treats Neon as the source of truth.

Normal startup is read-only for schema. It validates that the required feeder tables already exist, but it does not create tables, add columns, add indexes, or alter constraints.

Required tables:

| Table | Purpose |
|---|---|
| `provider_feeder_jobs` | Queue of mapped-source search jobs. |
| `google_maps_raw_results` | Raw mapped-source rows captured per job. |
| `provider_feeder_candidates` | Normalized/deduped provider candidates owned by this feeder. |
| `provider_feeder_candidate_sources` | Links candidates to raw source rows and jobs. |
| `provider_feeder_runs` | Run history for each claimed job. |

## Dashboard

Open the Render service URL directly.

| Route | Purpose |
|---|---|
| `/` | Dashboard UI. |
| `/dashboard` | Dashboard UI. |
| `/api/dashboard` | Dashboard data as JSON. |
| `/health` | Machine-readable health check. |
| `/healthz` | Machine-readable health check. |
| `/status` | Machine-readable status check. |

The dashboard shows job counts, raw result counts, candidate counts, source counts, recent jobs, recent candidates, recent errors, and current worker status.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `DATABASE_URL` | — | Neon connection string. Required. |
| `FREE_ONLY_MODE` | `1` | Keeps source policy locked to mapped-source providers. |
| `SCRAPER_PROVIDER` | `parallel_mapped_http` | Provider policy label for the active scraper. |
| `MAP_SOURCES` | `bing,google,apple` | Comma-separated mapped sources to run in parallel. |
| `MAP_HTTP_TIMEOUT_MS` | `30000` | Timeout per mapped-source HTTP request. |
| `MAX_RESULTS_PER_SOURCE` | `40` | Max accepted results from each source per job. |
| `MAX_RESULTS_PER_JOB` | `120` | Max merged results written per job. |
| `MAX_JOBS_PER_LOOP` | `1` | Jobs claimed per worker loop. |
| `DEFAULT_CONCURRENCY` | `1` | Kept for compatibility; current mapped HTTP path runs sources in parallel per job. |
| `VALIDATE_SCHEMA_ON_START` | `1` | Validate required feeder tables before polling. |
| `AUTO_SEED_ON_START` | `1` | Seed backlog jobs when active queue is low. |
| `MIN_PENDING_JOBS` | `25` | Minimum pending/running jobs before auto-seeding more. |
| `MAX_AUTO_SEED_JOBS` | `250` | Max jobs inserted during one auto-seed pass. |
| `RESET_STALE_RUNNING_MINUTES` | `120` | Return old stuck running jobs to pending. |
| `TARGET_STATES` | blank | Optional state filter, for example `CA,TX,FL`. |
| `TARGET_CITIES` | blank | Optional city filter, for example `Fresno CA,Pensacola FL`. |
| `TARGET_SERVICE_LINES` | blank | Optional service-line filter. |
| `DEFAULT_RADIUS_METERS` | `40000` | Radius stored on seeded jobs when the column exists. |
| `DEFAULT_SCRAPER_DEPTH` | `1` | Legacy-compatible job field. |
| `DEFAULT_FAST_MODE` | `0` | Legacy-compatible job field. |

Service-line keys:

```text
occupational_health
occupational_medicine
pre_employment
dot_physical
workers_comp
physical_ability
occupational_audiogram
occupational_spirometry
```

## Render deployment

Use `render.yaml`.

The Render service is a Docker web service so the dashboard can load in the browser while the worker continues processing jobs.

Required Render secret/env var:

```text
DATABASE_URL=<Neon connection string>
```

Everything else has safe defaults in `render.yaml`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run worker` | Start source-policy check and worker/dashboard server. |
| `npm run seed` | Manually seed targeted jobs. |
| `npm run seed:targeted` | Same as `seed`. |
| `npm run smoke` | Verify database connection and required feeder tables. |
| `npm run check` | Syntax-check source and script files. |

## Useful SQL checks

```sql
SELECT status, count(*)
FROM provider_feeder_jobs
GROUP BY status
ORDER BY status;

SELECT count(*) FROM google_maps_raw_results;
SELECT count(*) FROM provider_feeder_candidates;

SELECT id, query, status, attempts, error, created_at, completed_at
FROM provider_feeder_jobs
ORDER BY id DESC
LIMIT 25;

SELECT name, address, phone, website, confidence_score, status
FROM provider_feeder_candidates
ORDER BY updated_at DESC
LIMIT 25;
```

## Scope

This is a controlled continuous feeder. It does not scrape every business on the internet. It creates targeted occupational-health search jobs, runs mapped sources in parallel, and grows the database job by job so Network Map can consume cleaner provider candidates later.
