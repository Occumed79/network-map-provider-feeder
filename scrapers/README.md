# Scrapy crawler ingestion

This folder turns the feeder into a crawler-capable provider ingestion app.

The mapped-page parser can stay, but Scrapy is the practical path for provider discovery from clinic directory pages and sitemap-driven location pages.

## What it does

- Crawls public clinic/location directories from configurable source files.
- Extracts provider rows: name, address, city, state, phone, website, services, source URL, and optional coordinates.
- Can write directly into Neon when `SCRAPY_WRITE_TO_NEON=1`.
- Writes raw source rows into `google_maps_raw_results` with `raw.source = scrapy_directory`.
- Writes staging rows into `provider_feeder_candidates`.
- Upserts final app-facing rows into `provider_candidates` when `ENABLE_APP_CANDIDATE_WRITE=1`.

## Run a crawler

From the `scrapers` folder:

```bash
SCRAPY_WRITE_TO_NEON=1 scrapy crawl clinic_directory -a config=sources/my-source.json -O output/my-source.jsonl
```

## Environment

```text
DATABASE_URL=<Neon URL>
SCRAPY_WRITE_TO_NEON=1
ENABLE_APP_CANDIDATE_WRITE=1
APP_CANDIDATE_TABLE=provider_candidates
```

## Current direction

The app is no longer forced to live or die by consumer map HTML parsing. The useful flow is now:

```text
clinic directory pages / sitemap pages
→ Scrapy extracted provider rows
→ raw rows
→ feeder staging/dedupe
→ provider_candidates
```
