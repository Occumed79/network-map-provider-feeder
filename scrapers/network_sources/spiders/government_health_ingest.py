import csv
import json
from pathlib import Path

from network_sources.spiders.generic_provider_url import BaseDeepProviderSpider, clean


class GovernmentHealthIngestSpider(BaseDeepProviderSpider):
    name = "government_health_ingest"

    def __init__(
        self,
        source_file="all",
        countries="",
        crawl_mode="facility_registry",
        max_sources="50",
        include_disabled="1",
        run_key="",
        max_depth="8",
        same_domain="1",
        config_json="{}",
        *args,
        **kwargs,
    ):
        super().__init__(run_key=run_key, max_depth=max_depth, same_domain=same_domain, *args, **kwargs)
        self.mode = "government_health_ingest"
        self.source_tag = "government_health_registry"
        wanted_countries = {clean(value).lower() for value in countries.split(",") if clean(value)}
        wanted_mode = clean(crawl_mode).lower() or "facility_registry"
        include_disabled_value = str(include_disabled).strip().lower() not in {"0", "false", "no", "off"}
        source_limit = max(1, int(max_sources or 50))
        source_files = (
            ["sources/government_health_sources.csv", "sources/government_health_sources_part2.csv"]
            if source_file == "all"
            else [
                "sources/government_health_sources_part2.csv"
                if source_file == "part2"
                else "sources/government_health_sources.csv"
            ]
        )
        seeds = []
        for source_path_value in source_files:
            source_path = Path(source_path_value)
            if not source_path.is_absolute():
                source_path = Path.cwd() / source_path
            if not source_path.exists():
                raise ValueError(f"source file not found: {source_path}")
            with source_path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    country = clean(row.get("country"))
                    url = clean(row.get("url"))
                    row_mode = clean(row.get("crawlMode")).lower() or "authority_discovery"
                    enabled = clean(row.get("enabled")).lower() not in {"0", "false", "no", "off"}
                    if not country or not url:
                        continue
                    if wanted_countries and country.lower() not in wanted_countries:
                        continue
                    if wanted_mode not in {"all", "any"} and row_mode != wanted_mode:
                        continue
                    if not include_disabled_value and not enabled:
                        continue
                    seeds.append(
                        {
                            "url": url,
                            "country": country,
                            "source_tag": clean(row.get("sourceTag")) or f"gov_health_{country.lower().replace(' ', '-')}",
                        }
                    )
                    if len(seeds) >= source_limit:
                        break
            if len(seeds) >= source_limit:
                break
        if not seeds:
            raise ValueError("No government health sources matched the selected countries and crawl mode")
        self.seed_sources = seeds
        try:
            self.run_config = json.loads(config_json or "{}")
        except Exception:
            self.run_config = {}
        self.run_config.update(
            {
                "mode": self.mode,
                "sourceFile": source_file,
                "countries": countries,
                "crawlMode": wanted_mode,
                "maxSources": source_limit,
                "includeDisabled": include_disabled_value,
                "maxDepth": self.max_depth,
                "runKey": self.run_key,
            }
        )
        self.logger.info(
            "Loaded %s government health provider crawl seeds; countries=%s mode=%s",
            len(self.seed_sources),
            countries or "all",
            wanted_mode,
        )
