import inspect
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scrapers"))

from network_sources.spiders.government_health_ingest import GovernmentHealthIngestSpider


class ScrapyStartupCompatibilityTests(unittest.TestCase):
    def test_government_spider_implements_async_start(self):
        self.assertTrue(inspect.isasyncgenfunction(GovernmentHealthIngestSpider.start))

    def test_async_start_yields_legacy_requests(self):
        spider = object.__new__(GovernmentHealthIngestSpider)
        spider.seed_sources = [{"url": "https://example.test", "country": "US", "source_tag": "test"}]
        spider.run_key = "test-run"
        spider.start_requests = lambda: iter(["request-1", "request-2"])

        async def collect():
            return [item async for item in spider.start()]

        import asyncio

        self.assertEqual(asyncio.run(collect()), ["request-1", "request-2"])


if __name__ == "__main__":
    unittest.main()
