import json
from pathlib import Path

import scrapy

from network_sources.items import ClinicLocationItem


class ClinicDirectorySpider(scrapy.Spider):
    name = "clinic_directory"

    def __init__(self, config=None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not config:
            raise ValueError("Missing required arg: -a config=path/to/source.json")
        config_path = Path(config)
        if not config_path.exists():
            raise ValueError(f"Config not found: {config_path}")
        self.source_config = json.loads(config_path.read_text(encoding="utf-8"))
        self.source_tag = self.source_config.get("sourceTag", config_path.stem)
        self.allowed_domains = self.source_config.get("allowedDomains", [])
        self.start_urls = self.source_config.get("startUrls", [])
        if not self.start_urls:
            raise ValueError(f"No startUrls configured in {config_path}")

    def parse(self, response):
        list_selector = self.source_config.get("listSelector")
        fields = self.source_config.get("fields", {})
        if list_selector:
            for node in response.css(list_selector):
                item = self._item_from_node(node, response, fields)
                detail_rule = self.source_config.get("follow", {}).get("detailLinks", {})
                detail_links = self._extract_all(node, detail_rule)
                if detail_links:
                    for href in detail_links:
                        yield response.follow(href, callback=self.parse_detail, cb_kwargs={"seed": dict(item)})
                else:
                    yield item
        else:
            yield self._item_from_node(response, response, fields)

        for href in self._extract_all(response, self.source_config.get("follow", {}).get("pagination", {})):
            yield response.follow(href, callback=self.parse)

    def parse_detail(self, response, seed=None):
        item = ClinicLocationItem(seed or {})
        for field_name, rule in self.source_config.get("detailFields", {}).items():
            value = self._extract_one(response, rule)
            if value:
                item[field_name] = value
        item["sourceUrl"] = response.url
        yield item

    def _item_from_node(self, node, response, fields):
        item = ClinicLocationItem()
        for field_name, value in self.source_config.get("defaults", {}).items():
            item[field_name] = value
        for field_name, rule in fields.items():
            value = self._extract_one(node, rule)
            if value:
                item[field_name] = value
        item.setdefault("sourceTag", self.source_tag)
        item.setdefault("sourceUrl", response.url)
        item.setdefault("internalStatus", "candidate")
        return item

    def _extract_one(self, node, rule):
        values = self._extract_all(node, rule)
        if not values:
            return None
        if isinstance(rule, dict) and rule.get("join"):
            return str(rule.get("join", " ")).join(values)
        return values[0]

    def _extract_all(self, node, rule):
        if not rule:
            return []
        if isinstance(rule, str):
            selector_type = "css"
            selector = rule
        else:
            selector_type = rule.get("type", "css")
            selector = rule.get("selector") or rule.get("css") or rule.get("xpath")
        if not selector:
            return []
        selected = node.xpath(selector) if selector_type == "xpath" or (isinstance(rule, dict) and rule.get("xpath")) else node.css(selector)
        return [" ".join(str(value).split()).strip() for value in selected.getall() if str(value).strip()]
