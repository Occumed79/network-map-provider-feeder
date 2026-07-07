import csv
import re
from pathlib import Path
from urllib.parse import urlparse

import scrapy


DIRECTORY_TERMS = [
    "facility", "facilities", "healthcare locator", "locator", "provider", "providers",
    "clinic", "clinics", "hospital", "hospitals", "medical", "doctor", "doctors",
    "registry", "register", "directory", "health map", "centros de salud", "prestadores",
    "renipress", "clues", "health facilities", "facility register", "health services",
]

IGNORE_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".css", ".js", ".ico", ".zip", ".rar",
)

TRUTHY = {"1", "true", "yes", "y", "on", "all"}
DISABLED = {"0", "false", "no", "n", "off"}


class GovernmentHealthDiscoverySpider(scrapy.Spider):
    name = "government_health_discovery"
    custom_settings = {
        "ITEM_PIPELINES": {},
        "ROBOTSTXT_OBEY": True,
        "DOWNLOAD_DELAY": 0.5,
        "CONCURRENT_REQUESTS": 6,
    }

    def __init__(self, source_file="sources/government_health_sources.csv", countries="", max_depth="1", max_pages_per_country="20", include_disabled="1", *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.source_file = source_file
        source_files = ["sources/government_health_sources.csv", "sources/government_health_sources_part2.csv"] if source_file == "all" else [source_file]
        resolved_files = []
        for item in source_files:
            p = Path(item)
            if not p.is_absolute():
                p = Path.cwd() / p
            if not p.exists():
                raise ValueError(f"source_file not found: {p}")
            resolved_files.append(p)
        wanted = {c.strip().lower() for c in countries.split(",") if c.strip()}
        include_disabled_sources = str(include_disabled).strip().lower() in TRUTHY
        self.max_depth = int(max_depth)
        self.max_pages_per_country = int(max_pages_per_country)
        self.page_counts = {}
        self.sources = []
        skipped_disabled = 0
        for source_path in resolved_files:
            with source_path.open("r", encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    country = (row.get("country") or "").strip()
                    url = (row.get("url") or "").strip()
                    enabled = str(row.get("enabled", "true")).strip().lower()
                    if not country or not url:
                        continue
                    if wanted and country.lower() not in wanted:
                        continue
                    if enabled in DISABLED and not include_disabled_sources and not wanted:
                        skipped_disabled += 1
                        continue
                    self.sources.append({
                        "country": country,
                        "sourceTag": (row.get("sourceTag") or self.slug(country)).strip(),
                        "url": url,
                        "crawlMode": (row.get("crawlMode") or "authority_discovery").strip(),
                        "notes": (row.get("notes") or "").strip(),
                    })
        self.allowed_domains = sorted({urlparse(s["url"]).hostname or "" for s in self.sources if urlparse(s["url"]).hostname})
        self.logger.info("Loaded %s government health seed sources from %s file(s); skipped_disabled=%s; include_disabled=%s; countries=%s", len(self.sources), len(resolved_files), skipped_disabled, include_disabled_sources, ",".join(sorted(wanted)) or "all")

    def start_requests(self):
        if not self.sources:
            self.logger.warning("No government health seed sources loaded. Check source_file, countries, and include_disabled settings.")
            return
        for source in self.sources:
            yield scrapy.Request(
                source["url"],
                callback=self.parse,
                cb_kwargs={"source": source, "depth": 0},
                dont_filter=True,
            )

    def parse(self, response, source, depth):
        country = source["country"]
        page_key = country.lower()
        self.page_counts[page_key] = self.page_counts.get(page_key, 0) + 1
        title = " ".join(response.css("title::text").getall()).strip()
        page_text = " ".join(response.css("body ::text").getall())[:5000]
        page_matches = self.matches(page_text + " " + title)
        if page_matches:
            yield self.item(source, response.url, "page", title, "", page_matches)

        if depth >= self.max_depth or self.page_counts.get(page_key, 0) >= self.max_pages_per_country:
            return

        for link in response.css("a"):
            href = link.attrib.get("href")
            if not href:
                continue
            next_url = response.urljoin(href)
            if not self.should_follow(response.url, next_url):
                continue
            anchor = " ".join(link.css("::text").getall()).strip()
            reasons = self.matches(anchor + " " + next_url)
            if not reasons:
                continue
            yield self.item(source, next_url, "link", title, anchor, reasons)
            yield scrapy.Request(next_url, callback=self.parse, cb_kwargs={"source": source, "depth": depth + 1})

    def item(self, source, discovered_url, kind, title, anchor_text, reasons):
        return {
            "country": source["country"],
            "sourceTag": source["sourceTag"],
            "crawlMode": source["crawlMode"],
            "source_url": source["url"],
            "discovered_url": discovered_url,
            "kind": kind,
            "title": title,
            "anchor_text": anchor_text,
            "match_reasons": "; ".join(reasons[:8]),
            "notes": source.get("notes", ""),
            "sourceType": "government_health_discovery",
        }

    def matches(self, text):
        text = (text or "").lower()
        return [term for term in DIRECTORY_TERMS if re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", text)]

    def should_follow(self, current_url, next_url):
        parsed = urlparse(next_url)
        if parsed.scheme not in {"http", "https"}:
            return False
        if any(parsed.path.lower().endswith(ext) for ext in IGNORE_EXTENSIONS):
            return False
        current_host = urlparse(current_url).hostname or ""
        next_host = parsed.hostname or ""
        return next_host == current_host or next_host.endswith(f".{current_host}")

    @staticmethod
    def slug(value):
        return "gov_health_" + re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
