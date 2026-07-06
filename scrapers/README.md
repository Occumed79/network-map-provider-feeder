# Scrapy crawler ingestion

This folder turns the feeder into a crawler-capable provider ingestion app.

The old mapped-page parser is gone. Scrapy is now used for provider discovery from clinic directory pages, sitemap-driven location pages, and official health source discovery.

## What it does

- Crawls public clinic/location directories from configurable source files.
- Extracts provider rows: name, address, city, state, phone, website, services, source URL, and optional coordinates.
- Can write provider rows directly into Neon when `SCRAPY_WRITE_TO_NEON=1`.
- Writes raw source rows into `google_maps_raw_results` with source metadata.
- Writes staging rows into `provider_feeder_candidates`.
- Upserts final app-facing rows into `provider_candidates` when `ENABLE_APP_CANDIDATE_WRITE=1`.
- Can discover likely provider/facility directory pages from official government health seed URLs.

## Government health source seeds

The file below stores official/best health links by country:

```text
sources/government_health_sources.csv
```

Run discovery across the full list:

```bash
scrapy crawl government_health_discovery -O output/government-health-discovered-links.csv
```

Limit discovery to specific countries:

```bash
scrapy crawl government_health_discovery -a countries="Ghana,Peru,Portugal" -O output/government-health-discovered-links.csv
```

Discovery output columns include:

```text
country
source_url
discovered_url
kind
title
anchor_text
match_reasons
```

This spider does not write providers to Neon. It finds likely registry/facility/provider pages so they can become targeted `clinic_directory` configs or downloaded/imported provider files.

## Run a provider crawler

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
clinic directory pages / sitemap pages / official health source leads
→ Scrapy extracted or discovered provider rows/pages
→ raw rows or crawler configs/imports
→ feeder staging/dedupe
→ provider_candidates
```
