import json
import re
from urllib.parse import urlparse

import scrapy

HEALTH_TYPES = {"MedicalBusiness", "MedicalClinic", "Hospital", "Physician", "Dentist"}
LINK_TERMS = ["facility", "provider", "clinic", "hospital", "location", "locator", "directory", "registry", "health-map", "centers", "doctors"]
HEALTH_TERMS = ["health", "medical", "clinic", "hospital", "doctor", "physician", "dentist", "therapy", "urgent care", "nursing", "rehabilitation"]
PHONE_RE = re.compile(r"(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
ZIP_RE = re.compile(r"\b\d{5}(?:-\d{4})?\b")
STATE_RE = re.compile(r"\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b", re.I)


def clean(v):
    if isinstance(v, list):
        return "; ".join(clean(x) for x in v if clean(x))
    if isinstance(v, dict):
        return ", ".join(clean(x) for x in v.values() if clean(x))
    return " ".join(str(v or "").replace("\xa0", " ").split()).strip(" ,;|")


def type_names(obj):
    t = obj.get("@type") or obj.get("type") or []
    if isinstance(t, str):
        return {t}
    if isinstance(t, list):
        return {str(x) for x in t}
    return set()


class GenericProviderUrlSpider(scrapy.Spider):
    name = "generic_provider_url"
    custom_settings = {"ITEM_PIPELINES": {}, "ROBOTSTXT_OBEY": True, "DOWNLOAD_DELAY": 0.25}

    def __init__(self, url=None, country="", source_tag="pasted_url", *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not url:
            raise ValueError("-a url=... is required")
        if urlparse(url).scheme not in {"http", "https"}:
            raise ValueError("url must be http/https")
        self.start_urls = [url]
        self.country = country
        self.source_tag = source_tag or "pasted_url"
        self.allowed_domains = [urlparse(url).hostname]

    def parse(self, response):
        yield from self.jsonld_rows(response)
        yield from self.text_rows(response)
        seen = set()
        for link in response.css("a"):
            href = link.attrib.get("href")
            if not href:
                continue
            url = response.urljoin(href)
            text = clean(" ".join(link.css("::text").getall()))
            blob = f"{text} {url}".lower()
            reasons = [t for t in LINK_TERMS if t in blob]
            if reasons and url not in seen:
                seen.add(url)
                yield {"type": "discovered_link", "name": text or url, "sourceUrl": url, "services": "; ".join(reasons), "sourceType": "pasted_url_scrape", "sourceTag": self.source_tag, "evidenceNote": response.url}

    def jsonld_rows(self, response):
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
                types = type_names(obj)
                blob = json.dumps(obj).lower()
                if types & HEALTH_TYPES or ("LocalBusiness" in types and any(t in blob for t in HEALTH_TERMS)):
                    addr = obj.get("address") or {}
                    geo = obj.get("geo") or {}
                    yield {"type": "provider_candidate", "name": clean(obj.get("name")), "address": clean(addr), "city": clean(addr.get("addressLocality") if isinstance(addr, dict) else ""), "state": clean(addr.get("addressRegion") if isinstance(addr, dict) else ""), "postalCode": clean(addr.get("postalCode") if isinstance(addr, dict) else ""), "country": clean(addr.get("addressCountry") if isinstance(addr, dict) else self.country), "phone": clean(obj.get("telephone")), "email": clean(obj.get("email")), "website": clean(obj.get("url")), "services": clean(obj.get("medicalSpecialty") or obj.get("description") or list(types)), "sourceUrl": response.url, "lat": clean(geo.get("latitude") if isinstance(geo, dict) else ""), "lng": clean(geo.get("longitude") if isinstance(geo, dict) else ""), "sourceType": "pasted_url_scrape", "sourceTag": self.source_tag, "evidenceNote": "json-ld"}

    def text_rows(self, response):
        lines = [clean(x) for x in response.css("body ::text").getall() if clean(x)]
        for i, line in enumerate(lines):
            blob = " ".join(lines[i:i+5])
            if not any(t in blob.lower() for t in HEALTH_TERMS):
                continue
            phone = PHONE_RE.search(blob)
            email = EMAIL_RE.search(blob)
            if not (phone or email or ZIP_RE.search(blob)):
                continue
            state = STATE_RE.search(blob)
            yield {"type": "provider_candidate", "name": line[:140], "address": blob[:500], "state": state.group(1).upper() if state else "", "postalCode": ZIP_RE.search(blob).group(0) if ZIP_RE.search(blob) else "", "phone": phone.group(0) if phone else "", "email": email.group(0) if email else "", "services": "visible text healthcare match", "sourceUrl": response.url, "sourceType": "pasted_url_scrape", "sourceTag": self.source_tag, "evidenceNote": blob[:1000]}
