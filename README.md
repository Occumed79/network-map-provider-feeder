# network-map-provider-feeder

Standalone feeder worker for Network Map. It runs controlled Google Maps extraction jobs, stores raw results, normalizes/deduplicates them into provider candidates, and writes to the same Neon Postgres database used by Network Map.

This repo is intentionally separate from the Network Map frontend. Network Map can read `provider_candidates` later without this worker changing the UI.

## What this pass finishes

The repo is no longer just a parked Docker-only skeleton. It now has:

- Render-ready Docker worker deployment.
- Embedded `google-maps-scraper` binary runtime instead of Docker-in-Docker.
- Automatic DB migration on worker startup.
- Automatic targeted job seeding so the worker has a backlog to scrape.
- Targeted occupational-health searches across major US cities.
- Geo/radius job support through `target_lat`, `target_lng`, `radius_meters`, `scraper_depth`, and `scraper_fast_mode`.
- Stale running-job recovery after deploys/restarts.
- Binary, Docker, and auto scraper modes for Render/local use.

## Architecture

```text
provider_feeder_jobs
        ↓
feeder worker
        ↓
google-maps-scraper binary / Docker image
        ↓
google_maps_raw_results
        ↓
provider_candidates + provider_candidate_sources
        ↓
Network Map reads candidate data later
```

## Tables

| Table | Purpose |
|---|---|
| `provider_feeder_jobs` | Controlled job queue with query, service line, geo/radius, status, and scraper settings. |
| `google_maps_raw_results` | Raw scraper output per job. |
| `provider_candidates` | Normalized/deduped provider records. |
| `provider_candidate_sources` | Links candidates to raw source rows. |
| `provider_feeder_runs` | Per-job run history. |

## Key environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `DATABASE_URL` | — | Neon connection string. Required. |
| `SCRAPER_MODE` | `binary` | `binary`, `docker`, or `auto`. Render uses `binary`. |
| `SCRAPER_BINARY` | `google-maps-scraper` | Binary name/path inside the container. |
| `SCRAPER_TIMEOUT_MS` | `300000` | Per-job scraper timeout. |
| `DEFAULT_CONCURRENCY` | `1` | Scraper concurrency. Keep low at first. |
| `MAX_JOBS_PER_LOOP` | `1` | Jobs claimed per worker loop. |
| `AUTO_MIGRATE_ON_START` | `1` | Run migration before polling. |
| `AUTO_SEED_ON_START` | `1` | Keep the queue stocked with targeted jobs. |
| `MIN_PENDING_JOBS` | `25` | Minimum active pending/running jobs before auto-seeding more. |
| `MAX_AUTO_SEED_JOBS` | `250` | Max jobs inserted by an auto-seed pass. |
| `TARGET_STATES` | blank | Optional comma list like `CA,TX,FL`. |
| `TARGET_CITIES` | blank | Optional comma list like `Fresno CA,Pensacola FL`. |
| `TARGET_SERVICE_LINES` | blank | Optional comma list of service keys. |
| `DEFAULT_RADIUS_METERS` | `40000` | Radius passed to geo-capable scraper jobs. |
| `DEFAULT_SCRAPER_DEPTH` | `1` | Scroll depth for seeded jobs. |
| `DEFAULT_FAST_MODE` | `0` | Enable scraper fast mode for seeded jobs. |
| `RESET_STALE_RUNNING_MINUTES` | `120` | Return stuck running jobs to pending after this many minutes. |

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

Use the included `render.yaml`. The important part is:

```yaml
runtime: docker
```

The previous Node runtime could install Node dependencies, but it could not reliably run `gosom/google-maps-scraper` on Render. This Docker worker runs the scraper binary inside the same container.

Required Render env var:

```text
DATABASE_URL=<your shared Neon connection string>
```

On startup the worker will:

1. Run the DB migration.
2. Reset stale running jobs.
3. Seed a targeted backlog if needed.
4. Poll jobs.
5. Write raw rows and normalized provider candidates into Neon.

## Local development

```bash
cp .env.example .env
# Set DATABASE_URL in .env
npm install
npm run migrate
npm run seed
npm run worker
```

For Docker local testing:

```bash
cp .env.example .env
# Set DATABASE_URL in .env
docker compose up --build
```

## Useful SQL checks

```sql
SELECT status, count(*)
FROM provider_feeder_jobs
GROUP BY status
ORDER BY status;

SELECT count(*) FROM google_maps_raw_results;
SELECT count(*) FROM provider_candidates;

SELECT id, query, status, attempts, error, created_at, completed_at
FROM provider_feeder_jobs
ORDER BY id DESC
LIMIT 25;

SELECT name, address, phone, website, confidence_score, status
FROM provider_candidates
ORDER BY updated_at DESC
LIMIT 25;
```

## Scope guardrail

This is still a controlled feeder. It does not brute-force every city or every business. It creates targeted occupational-health searches and grows the database job by job so Network Map can consume cleaner provider candidates later.
