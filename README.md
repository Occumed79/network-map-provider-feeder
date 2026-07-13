# Network Map Provider Feeder

A manually started, long-running provider crawler and ingestion dashboard for the Network Map provider database.

The service does **not** schedule itself or run a permanent background ingestion loop. An operator opens the dashboard, starts a crawl, lets it run for the selected duration, and resumes it later when needed.

## Current provider crawl workflow

```text
Provider directory or government facility registry
→ recursively follow provider, facility, location, detail, and pagination pages
→ extract provider records only
→ validate and deduplicate each provider
→ write raw source evidence to google_maps_raw_results
→ upsert provider_feeder_candidates
→ upsert final provider_candidates in Neon automatically
```

The deep crawler no longer treats discovered links as the final output. Links are used internally as the crawl frontier; the output is provider information.

## Long-run controls

The dashboard supports:

- runtime from minutes through 24 hours;
- maximum page count up to 100,000;
- crawl depth up to 20;
- configurable concurrency and request delay;
- same-domain provider, facility, location, detail, and pagination following;
- manual stop;
- resume from the last Neon checkpoint;
- provider counts, current URL, pending URL count, and Neon write count.

Valid providers discovered by live URL and government registry crawls are written to Neon automatically while the crawl is running. File and pasted-text imports remain preview-first.

## Durable checkpoints

Long crawl progress is stored in Neon:

- `provider_feeder_crawl_runs` stores run status, configuration, progress, and totals;
- `provider_feeder_crawl_pages` stores pending, processed, and failed URLs.

A timeout, service stop, or manual stop leaves the run resumable. Selecting **Resume last stopped crawl** continues the saved frontier instead of restarting the source from the beginning.

## Provider tables

| Table | Purpose |
|---|---|
| `google_maps_raw_results` | Raw provider/source evidence. The table name is legacy. |
| `provider_feeder_candidates` | Deduplicated feeder staging. |
| `provider_candidates` | Final app-facing provider rows. |
| `provider_feeder_crawl_runs` | Durable crawl run state and totals. |
| `provider_feeder_crawl_pages` | Durable crawl frontier and page checkpoints. |

## International records

The feeder preserves:

- country name and country code;
- city;
- full region/state/province text;
- international postal codes;
- international phone values;
- latitude and longitude when present.

Unknown countries use `XX` rather than being incorrectly assigned to the United States.

## Dashboard routes

| Route | Purpose |
|---|---|
| `/` or `/dashboard` | Operator dashboard. |
| `/api/dashboard` | Dashboard data. |
| `/api/run/scrape-url` | Start a deep provider-directory crawl with automatic Neon writes. |
| `/api/run/government-health-ingest` | Start a provider-extracting government registry crawl. |
| `/api/run/stop` | Stop the current crawl safely. |
| `/api/run/resume-last` | Resume the latest stopped or failed crawl from Neon. |
| `/api/run/status` | Current and recent local run status. |
| `/health`, `/healthz`, `/status` | Health checks. |

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `DATABASE_URL` | — | Neon connection string. Required. |
| `ENABLE_SCHEMA_BOOTSTRAP` | `1` | Create and update feeder-owned tables. |
| `VALIDATE_SCHEMA_ON_START` | `1` | Validate feeder tables at startup. |
| `ENABLE_APP_CANDIDATE_WRITE` | `1` | Write accepted providers into the final app table. |
| `APP_CANDIDATE_TABLE` | `provider_candidates` | Final app-facing provider table. |
| `SCRAPY_WRITE_TO_NEON` | `0` | Set automatically to `1` for dashboard-started live crawls. |
| `MANUAL_DOWNLOAD_MAX_BYTES` | `100000000` | Maximum remote file download size. |
| `DASHBOARD_SHOW_LEGACY` | `0` | Show the removed legacy map-worker data. |

## Commands

```bash
npm run worker
npm run check
npm run test:imports
```

Manual CLI deep crawl with automatic Neon writes:

```bash
cd scrapers
SCRAPY_WRITE_TO_NEON=1 ENABLE_APP_CANDIDATE_WRITE=1 \
  scrapy crawl generic_provider_url \
  -a url=https://example.org/locations \
  -a country=US \
  -a run_key=example-run \
  -a max_depth=8 \
  -s CLOSESPIDER_TIMEOUT=28800 \
  -s CLOSESPIDER_PAGECOUNT=5000
```

## Deployment shape

The Render web service starts the dashboard and schema checks. It does not automatically schedule crawls. A crawl begins only when the operator presses Run.
