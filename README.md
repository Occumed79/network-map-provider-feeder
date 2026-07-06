# network-map-provider-feeder

Standalone feeder worker for Network Map. It runs controlled Google Maps extraction jobs, stores raw results, normalizes/deduplicates them into provider candidates, and writes to the same Neon Postgres database used by Network Map.

This repo is intentionally separate from the Network Map frontend. Network Map can read `provider_candidates` later without this worker changing the UI.

## Important Neon guardrail

This feeder must **not** alter the shared Neon schema by default. It now treats Neon as the source of truth:

- Startup performs read-only schema validation only.
- No table creation, column creation, index creation, or constraint changes happen during normal worker startup.
- Job seeding checks the existing `provider_feeder_jobs` columns and only inserts values into columns that already exist.
- The manual migration script is guarded and refuses to run unless `ALLOW_SCHEMA_CHANGES=1` is explicitly set.

## What this service does

- Deploys as a Render-ready Docker worker.
- Runs `google-maps-scraper` from inside the worker container.
- Polls existing `provider_feeder_jobs` rows.
- Seeds targeted backlog jobs when enabled, while conforming to existing Neon columns.
- Stores raw scraper output in `google_maps_raw_results`.
- Normalizes/deduplicates rows into `provider_candidates`.
- Links candidates to raw rows in `provider_candidate_sources`.
- Resets stale running jobs after deploys/restarts.

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

## Tables read/written by the worker

| Table | Purpose |
|---|---|
| `provider_feeder_jobs` | Existing job queue with query/status/attempt fields. Optional columns are used only if already present. |
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
| `VALIDATE_SCHEMA_ON_START` | `1` | Read-only validation of expected tables/required job columns. |
| `AUTO_SEED_ON_START` | `1` | Keep the queue stocked with targeted jobs. |
| `MIN_PENDING_JOBS` | `25` | Minimum active pending/running jobs before auto-seeding more. |
| `MAX_AUTO_SEED_JOBS` | `250` | Max jobs inserted by an auto-seed pass. |
| `ALLOW_SCHEMA_CHANGES` | `0` | Guard for manual migration only. Keep off for normal deployment. |
| `TARGET_STATES` | blank | Optional comma list like `CA,TX,FL`. |
| `TARGET_CITIES` | blank | Optional comma list like `Fresno CA,Pensacola FL`. |
| `TARGET_SERVICE_LINES` | blank | Optional comma list of service keys. |
| `DEFAULT_RADIUS_METERS` | `40000` | Used only if Neon already has `radius_meters`. |
| `DEFAULT_SCRAPER_DEPTH` | `1` | Used only if Neon already has `scraper_depth`. |
| `DEFAULT_FAST_MODE` | `0` | Used only if Neon already has `scraper_fast_mode`. |
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

Required Render env var:

```text
DATABASE_URL=<your shared Neon connection string>
```

On startup the worker will:

1. Validate the existing Neon schema without changing it.
2. Reset stale running jobs.
3. Seed a targeted backlog if enabled, using only columns that exist in Neon.
4. Poll jobs.
5. Write raw rows and normalized provider candidates into the existing tables.

## Local development

```bash
cp .env.example .env
# Set DATABASE_URL in .env
npm install
npm run smoke
npm run seed
npm run worker
```

Do not run migrations against the shared Neon DB unless that is explicitly intended:

```bash
ALLOW_SCHEMA_CHANGES=1 npm run migrate
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

This is still a controlled feeder. It does not brute-force every city or every business. It creates targeted occupational-health searches and grows the database job by job so Network Map can consume cleaner provider candidates later, while conforming to the existing Neon schema.
