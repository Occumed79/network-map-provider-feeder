# Free-only source policy

This feeder is intended to run without commercial data fallbacks.

Allowed source path:

- `gosom/google-maps-scraper`
- local worker logic in this repository
- existing shared Neon tables
- future website enrichment that crawls public clinic websites directly
- public/government/open datasets that do not require a paid subscription

Not in scope:

- commercial maps/place lookup services
- commercial search-result APIs
- commercial hosted scraping platforms
- paid enrichment feeds
- anything that requires a per-request vendor account to collect provider data

Implementation rule:

The feeder should improve power by tuning the free scraper, adding queue control, adding public website enrichment, improving dedupe, and using open/public datasets. It should not add paid fallback providers.
