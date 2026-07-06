# Government health source manifest

`government_health_sources.csv` is the official-health-source list supplied for international provider discovery.

It is intentionally a manifest, not a pile of fake scraper configs. These sites do not share one HTML pattern.

## Columns

| Column | Meaning |
|---|---|
| `country` | Country or territory name. |
| `sourceTag` | Stable source label to use when importing rows into Neon. |
| `url` | Official health authority, facility registry, or locator URL. |
| `allowedDomain` | Domain Scrapy should stay inside for that source. |
| `crawlMode` | `facility_registry` means likely direct facility/provider source; `authority_discovery` means ministry/authority page that needs discovery or a country-specific config. |
| `enabled` | Default `False`; sources should be promoted one by one after review. |
| `notes` | Short handling note. |

## How to use this without making a mess

Start with rows where:

```text
crawlMode=facility_registry
```

Those are the most likely to produce actual facility/provider rows.

Do not mass-enable every country at once. For each source:

1. Open the URL.
2. Confirm it contains facility/provider results or a downloadable register.
3. Create a country-specific Scrapy config only if the page has extractable HTML.
4. If the page provides CSV/XLS/PDF data, use the file import/PDF tools instead of forcing Scrapy.
5. Run a preview/export first.
6. Only write to Neon after reviewing accepted/rejected rows.

## Recommended source priority

1. `facility_registry` rows with visible provider/facility listings.
2. `facility_registry` rows with downloadable CSV/XLS/PDF registers.
3. `authority_discovery` rows that link to facility directories.
4. Plain ministry homepages last.

## Source-type labels

Use these source types when writing rows:

```text
government_health_registry
government_health_directory
government_health_pdf
government_health_download
```

Keep `sourceTag` country-specific, for example:

```text
gov_health_ghana
gov_health_peru
gov_health_qatar
```

## Examples

Preview an already downloaded government file:

```bash
npm run import:providers -- data/ghana-facilities.jsonl --source-type government_health_registry --source-tag gov_health_ghana --accepted-out output/ghana-accepted.csv --rejected-out output/ghana-rejected.csv
```

Write after review:

```bash
SCRAPY_WRITE_TO_NEON=1 npm run import:providers -- data/ghana-facilities.jsonl --source-type government_health_registry --source-tag gov_health_ghana --write
```

Create a Scrapy config only when the facility page has repeatable selectors. Do not use one generic selector config for all countries.
