import hashlib
import os

from itemadapter import ItemAdapter
from scrapy import signals
from scrapy.exceptions import DropItem

from network_sources.db import ensure_feeder_tables, open_connection, write_provider


class CleanClinicLocationPipeline:
    def process_item(self, item, spider):
        adapter = ItemAdapter(item)
        if adapter.get("type") == "discovered_link":
            raise DropItem("Discovery links are not provider records")

        for field_name in list(adapter.field_names()):
            value = adapter.get(field_name)
            if isinstance(value, list):
                value = "; ".join(str(v).strip() for v in value if str(v).strip())
            if value is not None:
                adapter[field_name] = " ".join(str(value).replace("\xa0", " ").split()).strip()

        if not adapter.get("address"):
            address = " ".join(part for part in [adapter.get("address1"), adapter.get("address2")] if part).strip()
            if address:
                adapter["address"] = address

        if adapter.get("region") and not adapter.get("state"):
            adapter["state"] = adapter.get("region")
        if adapter.get("state") and not adapter.get("region"):
            adapter["region"] = adapter.get("state")

        adapter.setdefault("sourceTag", getattr(spider, "source_tag", "scrapy_directory"))
        adapter.setdefault("sourceType", "scrapy_directory")
        adapter.setdefault("internalStatus", "candidate")
        adapter.setdefault("crawlRunKey", getattr(spider, "run_key", ""))

        if not adapter.get("name"):
            raise DropItem(f"Missing provider name: {dict(adapter)}")

        location_or_contact = any(
            adapter.get(field)
            for field in (
                "address", "city", "state", "region", "postalCode", "country", "phone", "email",
                "website", "sourceUrl", "lat", "lng",
            )
        )
        if not location_or_contact:
            raise DropItem(f"Missing provider location/contact evidence: {dict(adapter)}")

        evidence_url = adapter.get("sourceUrl")
        if evidence_url:
            adapter["evidenceUrl"] = evidence_url
        identity = "|".join(
            str(adapter.get(field) or "").strip().lower()
            for field in ("name", "address", "city", "region", "postalCode", "country", "phone", "website")
        )
        adapter["sourceUrl"] = f"provider-fingerprint://{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"
        return item


class NeonProviderPipeline:
    def __init__(self):
        self.conn = None
        self.pending = 0
        self.written = 0
        self.skipped = 0

    @classmethod
    def from_crawler(cls, crawler):
        pipeline = cls()
        crawler.signals.connect(pipeline.spider_opened, signal=signals.spider_opened)
        crawler.signals.connect(pipeline.spider_closed, signal=signals.spider_closed)
        return pipeline

    def spider_opened(self, spider):
        if os.getenv("SCRAPY_WRITE_TO_NEON", "0") == "1":
            self.conn = open_connection()
            if self.conn is None:
                spider.logger.error("SCRAPY_WRITE_TO_NEON=1 but DATABASE_URL is missing")
            else:
                with self.conn.cursor() as cur:
                    ensure_feeder_tables(cur)
                self.conn.commit()

    def process_item(self, item, spider):
        if os.getenv("SCRAPY_WRITE_TO_NEON", "0") != "1":
            return item
        if self.conn is None:
            raise DropItem("Neon writer unavailable")
        try:
            result = write_provider(dict(ItemAdapter(item)), conn=self.conn, commit=False, ensure_schema=False)
            status = result.get("status", "unknown")
            spider.crawler.stats.inc_value(f"neon/{status}")
            if result.get("app_status"):
                spider.crawler.stats.inc_value(f"neon/app/{result['app_status']}")
            if status == "written":
                self.written += 1
            else:
                self.skipped += 1
            self.pending += 1
            if self.pending >= 25:
                self.conn.commit()
                self.pending = 0
                spider.logger.info(
                    "NEON_PROGRESS written=%s skipped=%s run_key=%s",
                    self.written,
                    self.skipped,
                    getattr(spider, "run_key", ""),
                )
            return item
        except Exception:
            self.conn.rollback()
            self.pending = 0
            raise

    def spider_closed(self, spider, reason):
        if self.conn is not None:
            try:
                self.conn.commit()
                spider.logger.info(
                    "NEON_PROGRESS written=%s skipped=%s run_key=%s final=1",
                    self.written,
                    self.skipped,
                    getattr(spider, "run_key", ""),
                )
            finally:
                self.conn.close()
                self.conn = None
