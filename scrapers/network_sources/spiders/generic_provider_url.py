import json
import re
from datetime import datetime, timezone
from urllib.parse import urldefrag, urlparse

import scrapy

from network_sources.db import CrawlCheckpointStore

HEALTH_TYPES = {
    "MedicalBusiness", "MedicalClinic", "Hospital", "Physician", "Dentist", "Pharmacy",
    "DiagnosticLab", "EmergencyService", "HealthAndBeautyBusiness", "Optician",
}
HEALTH_TERMS = [
    "health", "medical", "clinic", "hospital", "doctor", "physician", "dentist", "dental",
    "therapy", "urgent care", "nursing", "rehabilitation", "laboratory", "imaging", "radiology",
    "occupational medicine", "primary care", "family medicine", "cardiology", "orthopedic",
]
FOLLOW_TERMS = [
    "facility", "facilities", "provider", "providers", "clinic", "clinics", "hospital", "hospitals",
    "location", "locations", "locator", "directory", "registry", "register", "find-a-doctor",
    "find-doctor", "find-care", "health-center", "health-centre", "medical-center", "medical-centre",
    "practice", "practices", "office", "offices", "department", "departments", "service", "services",
    "page=", "/page/", "offset=", "start=", "next", "pagination",
]
SKIP_TERMS = [
    "login", "signin", "sign-in", "logout", "privacy", "terms", "cookie", "facebook.com",
    "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "mailto:", "tel:",
    "javascript:", "calendar", "donate", "careers", "jobs", "news", "press", "blog",
]
SKIP_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico", ".css", ".js", ".zip", ".rar",
    ".mp3", ".mp4", ".avi", ".mov", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
)
PHONE_RE = re.compile(r"(?:\+?\d{1,3}[\s().-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
POSTAL_RE = re.compile(r"\b(?:\d{4,6}(?:-\d{3,4})?|[A-Z]\d[A-Z][ -]?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})\b", re.I)


def clean(value):
    if isinstance(value, list):
        return "; ".join(clean(v) for v in value if clean(v))
    if isinstance(value, dict):
        return ", ".join(clean(v) for v in value.values() if clean(v))
    return " ".join(str(value or "").replace("\xa0", " ").split()).strip(" ,;|")


def type_names(obj):
    raw = obj.get("@type") or obj.get("type") or []
    if isinstance(raw, str):
        return {raw}
    if isinstance(raw, list):
        return {str(v) for v in raw}
    return set()


def truthy(value, default=True):
    if value is None:
        return default
    return str(value).strip().lower() not in {"0", "false", "no", "off"}


def normalized_url(value):
    url, _fragment = urldefrag(value)
    return url.rstrip("/") or url


class BaseDeepProviderSpider(scrapy.Spider):
    custom_settings = {
        "ROBOTSTXT_OBEY": True,
        "AUTOTHROTTLE_ENABLED": True,
        "AUTOTHROTTLE_TARGET_CONCURRENCY": 2.0,
        "LOGSTATS_INTERVAL": 30,
        "RETRY_TIMES": 3,
        "DOWNLOAD_TIMEOUT": 45,
        "HTTPERROR_ALLOW_ALL": True,
    }

    def __init__(self, run_key="", max_depth="8", same_domain="1", *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.run_key = clean(run_key) or f"manual-{int(datetime.now(tz=timezone.utc).timestamp())}"
        self.max_depth = max(1, int(max_depth or 8))
        self.same_domain = truthy(same_domain, True)
        self.seed_sources = []
        self.processed_urls = set()
        self.queued_urls = set()
        self.pages_seen = 0
        self.providers_seen = 0
        self.source_tag = "deep_provider_crawl"
        self.mode = "deep_provider_crawl"
        self.run_config = {}
        self.checkpoint = None

    def start_requests(self):
        start_url = self.seed_sources[0]["url"] if self.seed_sources else None
        self.checkpoint = CrawlCheckpointStore()
        self.checkpoint.start_run(self.run_key, self.mode, start_url, self.run_config)
        checkpoint = self.checkpoint.load(self.run_key)
        self.processed_urls = set(checkpoint.get("processed", set()))
        pending = checkpoint.get("pending", [])
        if pending:
            self.logger.info("Resuming run %s with %s pending URLs and %s completed URLs", self.run_key, len(pending), len(self.processed_urls))
            for row in pending:
                url = normalized_url(row["url"])
                self.queued_urls.add(url)
                yield self._request(
                    url,
                    int(row.get("depth") or 0),
                    row.get("parent_url"),
                    row.get("country"),
                    row.get("source_tag"),
                )
            return

        for seed in self.seed_sources:
            url = normalized_url(seed["url"])
            if self.checkpoint.queue(
                self.run_key,
                url,
                0,
                None,
                seed.get("country"),
                seed.get("source_tag"),
            ):
                self.queued_urls.add(url)
                yield self._request(url, 0, None, seed.get("country"), seed.get("source_tag"))

    def _request(self, url, depth, parent_url, country, source_tag):
        return scrapy.Request(
            url,
            callback=self.parse,
            errback=self.errback,
            dont_filter=True,
            meta={
                "crawl_depth": depth,
                "parent_url": parent_url,
                "country": country or "",
                "source_tag": source_tag or self.source_tag,
            },
        )

    def parse(self, response):
        url = normalized_url(response.url)
        depth = int(response.meta.get("crawl_depth", 0))
        country = clean(response.meta.get("country"))
        source_tag = clean(response.meta.get("source_tag")) or self.source_tag
        self.queued_urls.discard(url)

        if response.status >= 400:
            self.checkpoint.mark(self.run_key, url, "failed", depth, 0, response.status, f"HTTP {response.status}")
            return

        providers = self.extract_providers(response, country, source_tag)
        self.pages_seen += 1
        self.providers_seen += len(providers)
        self.processed_urls.add(url)
        self.checkpoint.mark(self.run_key, url, "processed", depth, len(providers), response.status, None)

        for provider in providers:
            yield provider

        if self.pages_seen == 1 or self.pages_seen % 10 == 0 or providers:
            self.logger.info(
                "CRAWL_PROGRESS pages=%s providers=%s pending=%s current=%s run_key=%s",
                self.pages_seen,
                self.providers_seen,
                len(self.queued_urls),
                url,
                self.run_key,
            )

        if depth >= self.max_depth:
            return

        links = []
        for link in response.css("a[href]"):
            href = link.attrib.get("href")
            if not href:
                continue
            next_url = normalized_url(response.urljoin(href))
            anchor = clean(" ".join(link.css("::text").getall()))
            score = self.link_score(response.url, next_url, anchor)
            if score <= 0:
                continue
            links.append((score, next_url))

        for _score, next_url in sorted(set(links), key=lambda x: (-x[0], x[1])):
            if next_url in self.processed_urls or next_url in self.queued_urls:
                continue
            if self.checkpoint.queue(self.run_key, next_url, depth + 1, url, country, source_tag):
                self.queued_urls.add(next_url)
                yield self._request(next_url, depth + 1, url, country, source_tag)
        self.checkpoint.flush()

    def errback(self, failure):
        request = failure.request
        url = normalized_url(request.url)
        depth = int(request.meta.get("crawl_depth", 0))
        self.queued_urls.discard(url)
        self.checkpoint.mark(self.run_key, url, "failed", depth, 0, None, clean(failure.value)[:1500])
        self.logger.warning("Crawl request failed url=%s error=%s", url, failure.value)

    def link_score(self, current_url, next_url, anchor=""):
        parsed = urlparse(next_url)
        current = urlparse(current_url)
        if parsed.scheme not in {"http", "https"}:
            return -100
        blob = f"{anchor} {next_url}".lower()
        if any(term in blob for term in SKIP_TERMS):
            return -100
        if any(parsed.path.lower().endswith(ext) for ext in SKIP_EXTENSIONS):
            return -100
        same_host = parsed.hostname == current.hostname or (
            parsed.hostname and current.hostname and parsed.hostname.endswith(f".{current.hostname}")
        )
        if self.same_domain and not same_host:
            return -100
        score = 1 if same_host else 0
        for term in FOLLOW_TERMS:
            if term in blob:
                score += 3 if term not in {"next", "page=", "/page/", "offset=", "start=", "pagination"} else 5
        if any(term in blob for term in HEALTH_TERMS):
            score += 2
        return score if score >= 3 else -1

    def extract_providers(self, response, country, source_tag):
        rows = []
        rows.extend(self.jsonld_rows(response, country, source_tag))
        rows.extend(self.card_rows(response, country, source_tag))
        if not rows:
            fallback = self.page_row(response, country, source_tag)
            if fallback:
                rows.append(fallback)

        seen = set()
        accepted = []
        for row in rows:
            name = clean(row.get("name"))
            address = clean(row.get("address"))
            phone = clean(row.get("phone"))
            key = (name.lower(), address.lower(), re.sub(r"\D+", "", phone), clean(row.get("website")).lower())
            if not name or key in seen:
                continue
            seen.add(key)
            row["crawlRunKey"] = self.run_key
            row["sourceType"] = "pasted_url_scrape" if self.mode == "scrape_url" else "government_health_registry"
            row["sourceTag"] = source_tag
            row["sourceUrl"] = row.get("sourceUrl") or response.url
            row["country"] = row.get("country") or country
            row["type"] = "provider_candidate"
            accepted.append(row)
        return accepted

    def jsonld_rows(self, response, country, source_tag):
        rows = []
        for script in response.css('script[type="application/ld+json"]::text').getall():
            try:
                data = json.loads(script)
            except Exception:
                continue
            stack = data if isinstance(data, list) else [data]
            while stack:
                obj = stack.pop(0)
                if not isinstance(obj, dict):
                    continue
                if isinstance(obj.get("@graph"), list):
                    stack.extend(obj["@graph"])
                for key in ("department", "subOrganization", "member", "itemListElement"):
                    child = obj.get(key)
                    if isinstance(child, list):
                        stack.extend(child)
                    elif isinstance(child, dict):
                        stack.append(child)
                types = type_names(obj)
                blob = json.dumps(obj, ensure_ascii=False).lower()
                if not (types & HEALTH_TYPES or ("LocalBusiness" in types and any(term in blob for term in HEALTH_TERMS))):
                    continue
                address = obj.get("address") or {}
                geo = obj.get("geo") or {}
                if isinstance(address, str):
                    address = {"streetAddress": address}
                row = {
                    "name": clean(obj.get("name")),
                    "address": clean(address.get("streetAddress") if isinstance(address, dict) else address),
                    "city": clean(address.get("addressLocality") if isinstance(address, dict) else ""),
                    "region": clean(address.get("addressRegion") if isinstance(address, dict) else ""),
                    "postalCode": clean(address.get("postalCode") if isinstance(address, dict) else ""),
                    "country": clean(address.get("addressCountry") if isinstance(address, dict) else country),
                    "phone": clean(obj.get("telephone")),
                    "email": clean(obj.get("email")),
                    "website": clean(obj.get("url")),
                    "services": clean(obj.get("medicalSpecialty") or obj.get("description") or list(types)),
                    "sourceUrl": response.url,
                    "lat": clean(geo.get("latitude") if isinstance(geo, dict) else ""),
                    "lng": clean(geo.get("longitude") if isinstance(geo, dict) else ""),
                    "evidenceNote": "json-ld",
                    "sourceTag": source_tag,
                }
                if row["name"]:
                    rows.append(row)
        return rows

    def card_rows(self, response, country, source_tag):
        selectors = [
            '[itemtype*="Medical"]', '[itemtype*="Hospital"]', '[itemtype*="Physician"]',
            '[class*="provider"]', '[class*="facility"]', '[class*="clinic"]', '[class*="location"]',
            '[class*="hospital"]', '[class*="practice"]', 'article', 'li',
        ]
        rows = []
        scanned = 0
        for selector in selectors:
            for node in response.css(selector):
                scanned += 1
                if scanned > 1500:
                    return rows
                text = clean(" ".join(node.css("::text").getall()))
                if len(text) < 12 or len(text) > 2500:
                    continue
                lower = text.lower()
                if not any(term in lower for term in HEALTH_TERMS):
                    continue
                phone = clean(node.css('a[href^="tel:"]::attr(href)').get())
                phone = phone.replace("tel:", "") if phone else clean((PHONE_RE.search(text) or [""])[0])
                email = clean(node.css('a[href^="mailto:"]::attr(href)').get())
                email = email.replace("mailto:", "") if email else clean((EMAIL_RE.search(text) or [""])[0])
                address = clean(" ".join(node.css("address ::text, address::text").getall()))
                if not address:
                    address = self.address_like_line(text)
                postal = clean((POSTAL_RE.search(text) or [""])[0])
                heading = clean(" ".join(node.css("h1::text,h2::text,h3::text,h4::text,h5::text,[itemprop='name']::text").getall()))
                name = heading or clean(node.css("::text").get())
                if not name or len(name) > 180:
                    continue
                website = clean(node.css('a[href^="http"]::attr(href)').get())
                if not (address or phone or email or postal or website):
                    continue
                rows.append({
                    "name": name,
                    "address": address,
                    "postalCode": postal,
                    "country": country,
                    "phone": phone,
                    "email": email,
                    "website": response.urljoin(website) if website else "",
                    "services": "; ".join(term for term in HEALTH_TERMS if term in lower)[:500],
                    "sourceUrl": response.url,
                    "sourceTag": source_tag,
                    "evidenceNote": text[:1500],
                })
        return rows

    def page_row(self, response, country, source_tag):
        title = clean(" ".join(response.css("h1::text,title::text").getall()))
        text = clean(" ".join(response.css("body ::text").getall()))[:8000]
        lower = f"{title} {text}".lower()
        if not title or not any(term in lower for term in HEALTH_TERMS):
            return None
        phone_match = PHONE_RE.search(text)
        email_match = EMAIL_RE.search(text)
        postal_match = POSTAL_RE.search(text)
        address = clean(" ".join(response.css("address ::text, address::text").getall())) or self.address_like_line(text)
        if not (address or phone_match or email_match or postal_match):
            return None
        return {
            "name": title[:180],
            "address": address,
            "postalCode": postal_match.group(0) if postal_match else "",
            "country": country,
            "phone": phone_match.group(0) if phone_match else "",
            "email": email_match.group(0) if email_match else "",
            "website": response.url,
            "services": "; ".join(term for term in HEALTH_TERMS if term in lower)[:500],
            "sourceUrl": response.url,
            "sourceTag": source_tag,
            "evidenceNote": text[:1500],
        }

    @staticmethod
    def address_like_line(text):
        chunks = re.split(r"[|•\n]", text)
        for chunk in chunks:
            chunk = clean(chunk)
            if len(chunk) < 8 or len(chunk) > 260:
                continue
            if any(ch.isdigit() for ch in chunk) and (POSTAL_RE.search(chunk) or re.search(r"\b(street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|way|suite|unit)\b", chunk, re.I)):
                return chunk
        return ""

    def closed(self, reason):
        status = "completed" if reason == "finished" else "paused"
        if self.checkpoint is not None:
            self.checkpoint.finish(self.run_key, status, None if status == "completed" else reason)
            self.checkpoint.close()
        self.logger.info(
            "CRAWL_COMPLETE status=%s reason=%s pages=%s providers=%s run_key=%s",
            status,
            reason,
            self.pages_seen,
            self.providers_seen,
            self.run_key,
        )


class GenericProviderUrlSpider(BaseDeepProviderSpider):
    name = "generic_provider_url"

    def __init__(self, url=None, country="", source_tag="pasted_url", run_key="", max_depth="8", same_domain="1", config_json="{}", *args, **kwargs):
        super().__init__(run_key=run_key, max_depth=max_depth, same_domain=same_domain, *args, **kwargs)
        if not url:
            raise ValueError("-a url=... is required")
        if urlparse(url).scheme not in {"http", "https"}:
            raise ValueError("url must be http/https")
        self.mode = "scrape_url"
        self.source_tag = clean(source_tag) or "pasted_url"
        self.seed_sources = [{"url": url, "country": clean(country), "source_tag": self.source_tag}]
        try:
            self.run_config = json.loads(config_json or "{}")
        except Exception:
            self.run_config = {}
        self.run_config.update({
            "mode": self.mode,
            "url": url,
            "country": clean(country),
            "sourceTag": self.source_tag,
            "maxDepth": self.max_depth,
            "runKey": self.run_key,
        })
