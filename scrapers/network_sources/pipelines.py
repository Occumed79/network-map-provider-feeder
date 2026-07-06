import os

from itemadapter import ItemAdapter
from scrapy.exceptions import DropItem

from network_sources.db import write_provider


class CleanClinicLocationPipeline:
    REQUIRED_FIELDS = ("name", "city", "state")

    def process_item(self, item, spider):
        adapter = ItemAdapter(item)
        for field_name in list(adapter.field_names()):
            value = adapter.get(field_name)
            if isinstance(value, list):
                value = " ".join(str(v).strip() for v in value if str(v).strip())
            if value is not None:
                adapter[field_name] = " ".join(str(value).replace("\xa0", " ").split()).strip()

        if not adapter.get("address"):
            address = " ".join(part for part in [adapter.get("address1"), adapter.get("address2")] if part).strip()
            if address:
                adapter["address"] = address

        if adapter.get("state"):
            adapter["state"] = str(adapter["state"]).strip().upper()[:2]
        adapter.setdefault("sourceTag", getattr(spider, "source_tag", "scrapy_directory"))
        adapter.setdefault("internalStatus", "candidate")
        if not adapter.get("website") and adapter.get("sourceUrl"):
            adapter["website"] = adapter.get("sourceUrl")

        missing = [field for field in self.REQUIRED_FIELDS if not adapter.get(field)]
        if missing:
            raise DropItem(f"Missing required fields {missing}: {dict(adapter)}")
        return item


class NeonProviderPipeline:
    def process_item(self, item, spider):
        if os.getenv("SCRAPY_WRITE_TO_NEON", "0") != "1":
            return item
        result = write_provider(dict(ItemAdapter(item)))
        spider.crawler.stats.inc_value(f"neon/{result.get('status', 'unknown')}")
        if result.get("app_status"):
            spider.crawler.stats.inc_value(f"neon/app/{result['app_status']}")
        return item
