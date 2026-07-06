# Scrapy crawler ingestion

This folder contains the Scrapy tools for provider ingestion.

## Provider crawler

Run a configured clinic/location crawler from the `scrapers` folder:

```bash
SCRAPY_WRITE_TO_NEON=1 scrapy crawl clinic_directory -a config=sources/my-source.json -O output/my-source.jsonl
```

## Government health source seeds

The official health source list is stored here:

```text
sources/government_health_sources.csv
```

Run the government source spider from the `scrapers` folder:

```bash
scrapy crawl government_health_discovery -O output/government-health-discovered-links.csv
```

Limit to selected countries:

```bash
scrapy crawl government_health_discovery -a countries="Ghana,Peru,Portugal" -O output/government-health-discovered-links.csv
```

This produces lead pages with country, source URL, discovered URL, title, anchor text, and match reasons. It does not write provider rows to Neon. Good leads can be turned into `clinic_directory` configs or downloaded files for `import_provider_text.py`.

## Environment

```text
DATABASE_URL=<Neon URL>
SCRAPY_WRITE_TO_NEON=1
ENABLE_APP_CANDIDATE_WRITE=1
APP_CANDIDATE_TABLE=provider_candidates
```
