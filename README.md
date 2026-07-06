# Network Map Provider Feeder

Render dashboard, Scrapy crawler ingestion, and provider-file cleanup tools for the Network Map provider database.

This repo no longer uses the old Bing/Google/Apple HTML map parser. The old map worker loop and source-policy files have been removed. Provider growth now comes from crawler configs and import tools that write cleaned provider rows into Neon.

## Current shape

- Runtime: Docker web service with Node dashboard and Python/Scrapy runtime installed.
- Deployment target: Render web service.
- Primary ingestion paths: Scrapy crawler configs and provider file imports.
- Database: existing Neon Postgres database.
- Final output: `provider_candidates`.
- Staging/dedupe: `provider_feeder_candidates`.
- Raw/source evidence: `google_maps_raw_results`.
- UI: built-in dashboard served from `/` and `/dashboard`.
- Health/API endpoints: `/health`, `/healthz`, `/status`, `/api/dashboard`.

## Current flows

```text
clinic directory pages / location pages
→ Scrapy spider extracts provider rows
→ google_maps_raw_results
→ provider_feeder_candidates
→ provider_candidates
```

```text
messy txt/csv/json/jsonl provider dumps
→ import_provider_text.py cleans provider-looking rows
→ google_maps_raw_results
→ provider_feeder_candidates
→ provider_candidates
```

```text
government health registry/source manifest
→ source reviewed one country at a time
→ Scrapy config or downloaded file import
→ provider_candidates
```

## What the Render web service does

1. Starts the dashboard and health endpoints.
2. Bootstraps feeder-owned Neon tables when enabled.
3. Validates required Neon tables.
4. Shows app candidates, staging candidates, raw rows, current source counts, and separated legacy source counts.

It does **not** run the old map job queue anymore.

## Ingestion modes

### 1. Scrapy crawler ingestion

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

### 2. Provider text/file import

Use `scripts/import_provider_text.py` for already-collected provider/location data that needs cleanup.

Accepted input formats:

```text
.txt
.csv
.json
.jsonl
```

The importer looks for provider-looking records and extracts:

```text
name
address
city
state
postalCode
phone
email
website
services
sourceUrl
lat/lng
```

It scores records for healthcare relevance and ignores obvious non-provider rows.

Preview to cleaned CSV:

```bash
npm run import:providers -- data/raw-provider-dump.txt --out output/cleaned-providers.csv
```

Write cleaned rows into Neon:

```bash
SCRAPY_WRITE_TO_NEON=1 npm run import:providers -- data/raw-provider-dump.txt --write
```

For UCSD-style JSONL or other already-collected records:

```bash
SCRAPY_WRITE_TO_NEON=1 npm run import:providers -- data/records.jsonl --format jsonl --source-tag ucsd_google_local_subset --write
```

### 3. Government health source manifest

The official-health-source list is stored at:

```text
scrapers/sources/government_health_sources.csv
```

It contains country-level official health authority, facility registry, and healthcare locator URLs.

The manifest has two handling modes:

| Mode | Meaning |
|---|---|
| `facility_registry` | Likely direct provider/facility source; review first and convert to Scrapy config or file import. |
| `authority_discovery` | Ministry/authority page; use only after finding a linked directory, register, CSV/XLS/PDF, or extractable listing. |

Do not mass-enable all sources. Promote sources one country at a time after review.

Start with:

```text
crawlMode=facility_registry
```

Then choose the correct path:

```text
HTML listing page → country-specific Scrapy config
CSV/XLS/JSON/JSONL download → import:providers
PDF directory → extract:pdf then import:providers
plain ministry homepage → discovery only; do not write to Neon
```

See:

```text
scrapers/sources/government_health_sources.README.md
```

## Required tables

| Table | Purpose |
|---|---|
| `google_maps_raw_results` | Raw crawler/import source evidence rows. Name is legacy, but still used as the raw table. |
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
| `SCRAPY_WRITE_TO_NEON` | `0` | When set to `1`, Python crawler/import rows are written into Neon. |
| `DASHBOARD_SHOW_LEGACY` | `0` | Show legacy map jobs/errors in dashboard. |

## Commands

| Command | Purpose |
|---|---|
| `npm run worker` | Start the Render dashboard/health service. |
| `npm run smoke` | Verify database connection and required feeder tables. |
| `npm run crawl:clinic -- -a config=sources/my-source.json` | Run the config-driven Scrapy clinic directory crawler from `scrapers/`. |
| `npm run import:providers -- <file>` | Clean/import provider-looking rows from txt/csv/json/jsonl files. |
| `npm run check` | Syntax-check the Node files. |

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
Render dashboard + Scrapy crawler ingestion + provider file cleanup + government source manifest + Neon final provider output
```

## Manual provider ingestion console

The Render service is now the **Provider Ingestion Dashboard**. It is a manual ingestion console, not a scheduled scraper system. The expected workflow is always **preview first** and **write second**.

Important tables:
- `provider_candidates` is the final app-facing output.
- `provider_feeder_candidates` is staging/dedupe only.
- `google_maps_raw_results` stores raw/source evidence despite the legacy table name.
- The old Bing/Google/Apple map/browser scraper is not present anymore.

### A. Paste URL from the frontend

1. Open the dashboard.
2. In **Manual Provider Ingestion → Scrape / Discover from URL**, paste a provider directory, government health page, clinic locator, hospital list, facility registry, or similar URL.
3. Click **Preview**.
4. Download `accepted.csv`, `rejected.csv`, `report.json`, and any discovered links/logs.
5. After review, click **Write to Neon** only when the accepted rows should be written.

The generic URL spider tries JSON-LD/schema.org healthcare entities, visible text contact/location blocks, and relevant provider/facility/location links. It is intentionally a best-effort generic extractor, not a magic site-specific scraper.

### B. Government health discovery

1. In **Government Health Seeds**, choose **All**, **Part 1**, or **Part 2**.
2. Optionally enter comma-separated countries.
3. Click **Run discovery**.
4. Download `discovered-links.csv` and use useful leads as future pasted URLs, configs, or imports.

### C. Document/file URL

1. In **Import Document/File URL**, paste a PDF, CSV, TXT, JSON, JSONL, or UCSD/Google Local-style file URL.
2. Choose the source type: `pdf_provider_directory`, `provider_file_import`, or `google_local_jsonl_import`.
3. Click **Preview**.
4. Download accepted/rejected/report outputs.
5. Click **Write to Neon** only after review.

PDFs are never written directly. The flow is: PDF URL → `extract_medical_providers.py` → CSV → `import_provider_text.py` preview → optional write.

### D. Raw text

1. Paste messy provider text into **Paste Raw Text**.
2. Click **Preview**.
3. Review/download accepted and rejected rows.
4. Write only after review.

### E. CLI examples

Scrapy directory write:

```bash
SCRAPY_WRITE_TO_NEON=1 npm run crawl:clinic -- -a config=sources/my-source.json
```

Government discovery:

```bash
cd scrapers
scrapy crawl government_health_discovery -O output/gov-health-links.csv
scrapy crawl government_health_discovery -a source_file=sources/government_health_sources_part2.csv -O output/gov-health-links-part2.csv
```

Google Local / UCSD-style file:

```bash
npm run import:providers -- Alabama.txt --source-type google_local_jsonl_import --source-tag ucsd_alabama --accepted-out output/alabama-accepted.csv --rejected-out output/alabama-rejected.csv --report-out output/alabama-report.json
```

After review:

```bash
SCRAPY_WRITE_TO_NEON=1 npm run import:providers -- Alabama.txt --source-type google_local_jsonl_import --source-tag ucsd_alabama --write
```

PDF:

```bash
npm run extract:pdf -- input.pdf output/providers.csv
npm run import:providers -- output/providers.csv --source-type pdf_provider_directory --source-tag embassy_pdf --accepted-out output/pdf-accepted.csv --rejected-out output/pdf-rejected.csv --report-out output/pdf-report.json
```
