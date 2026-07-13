import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scrapers"))

from scrapy.http import HtmlResponse, Request

from network_sources.db import row_values
from network_sources.pipelines import CleanClinicLocationPipeline
from network_sources.spiders.generic_provider_url import GenericProviderUrlSpider


class DeepProviderCrawlerTests(unittest.TestCase):
    def response(self, html, url="https://example.org/locations"):
        request = Request(url=url, meta={"crawl_depth": 0, "country": "Canada", "source_tag": "test"})
        return HtmlResponse(url=url, request=request, body=html.encode("utf-8"), encoding="utf-8")

    def test_jsonld_provider_is_extracted_as_provider_record(self):
        payload = {
            "@context": "https://schema.org",
            "@type": "MedicalClinic",
            "name": "Northside Occupational Health",
            "address": {
                "@type": "PostalAddress",
                "streetAddress": "10 Main Street",
                "addressLocality": "Toronto",
                "addressRegion": "Ontario",
                "postalCode": "M5V 2T6",
                "addressCountry": "Canada",
            },
            "telephone": "+1 416 555 0100",
            "url": "https://example.org/locations/toronto",
        }
        html = f"<html><head><script type='application/ld+json'>{json.dumps(payload)}</script></head><body></body></html>"
        spider = GenericProviderUrlSpider(url="https://example.org/locations", run_key="test-run")
        rows = spider.extract_providers(self.response(html), "Canada", "test")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "Northside Occupational Health")
        self.assertEqual(rows[0]["country"], "Canada")
        self.assertEqual(rows[0]["crawlRunKey"], "test-run")
        self.assertEqual(rows[0]["type"], "provider_candidate")

    def test_directory_cards_extract_provider_details_not_link_records(self):
        html = """
        <html><body>
          <div class="clinic-location">
            <h3>Central Medical Clinic</h3>
            <address>20 Queen Street, Toronto, ON M5H 2N2</address>
            <a href="tel:+14165550101">Call</a>
            <a href="/locations/central">Details</a>
          </div>
        </body></html>
        """
        spider = GenericProviderUrlSpider(url="https://example.org/locations", run_key="test-run")
        rows = spider.extract_providers(self.response(html), "Canada", "test")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "Central Medical Clinic")
        self.assertNotEqual(rows[0].get("type"), "discovered_link")

    def test_pagination_and_provider_links_are_followed_but_social_links_are_not(self):
        spider = GenericProviderUrlSpider(url="https://example.org/locations", run_key="test-run")
        self.assertGreater(spider.link_score("https://example.org/locations", "https://example.org/locations?page=2", "Next"), 0)
        self.assertGreater(spider.link_score("https://example.org/locations", "https://example.org/providers/abc", "Doctor profile"), 0)
        self.assertLess(spider.link_score("https://example.org/locations", "https://facebook.com/example", "Facebook"), 0)

    def test_live_pipeline_uses_provider_identity_not_shared_directory_url(self):
        pipeline = CleanClinicLocationPipeline()
        spider = SimpleNamespace(source_tag="test", run_key="run-1")
        first = pipeline.process_item(
            {
                "name": "Alpha Medical Clinic",
                "address": "10 Main Street",
                "city": "Toronto",
                "country": "Canada",
                "phone": "+1 416 555 1000",
                "sourceUrl": "https://example.org/locations",
            },
            spider,
        )
        second = pipeline.process_item(
            {
                "name": "Beta Urgent Care",
                "address": "20 Main Street",
                "city": "Toronto",
                "country": "Canada",
                "phone": "+1 416 555 2000",
                "sourceUrl": "https://example.org/locations",
            },
            spider,
        )
        self.assertNotEqual(first["sourceUrl"], second["sourceUrl"])
        self.assertEqual(first["evidenceUrl"], "https://example.org/locations")
        self.assertEqual(second["evidenceUrl"], "https://example.org/locations")

    def test_international_location_is_preserved(self):
        values = row_values(
            {
                "name": "Toronto Medical Centre",
                "address": "10 King Street",
                "city": "Toronto",
                "region": "Ontario",
                "postalCode": "M5H 1A1",
                "country": "Canada",
                "phone": "+1 416 555 0100",
                "sourceUrl": "provider-fingerprint://test",
            }
        )
        self.assertEqual(values["country_code"], "CA")
        self.assertEqual(values["country"], "Canada")
        self.assertEqual(values["region"], "Ontario")
        self.assertEqual(values["postal_code"], "M5H 1A1")


if __name__ == "__main__":
    unittest.main()
