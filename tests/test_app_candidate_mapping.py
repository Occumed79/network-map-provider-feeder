import sys
import unittest
from pathlib import Path

import psycopg2.extras

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scrapers"))

from network_sources.db import build_app_values, row_values


class AppCandidateMappingTests(unittest.TestCase):
    def test_network_map_candidate_contract(self):
        values = row_values({
            "name": "Central Occupational Clinic",
            "address": "10 Main Street",
            "city": "Toronto",
            "region": "Ontario",
            "postalCode": "M5V 2T6",
            "country": "Canada",
            "phone": "+1 416 555 0100",
            "website": "https://clinic.example",
            "sourceUrl": "https://directory.example/central",
            "services": "occupational medicine",
            "sourceType": "pasted_url_scrape",
            "sourceTag": "canada_registry",
        })
        columns = {
            "name", "normalized_name", "source_kind", "source_label", "clinic_type",
            "services", "categories", "address", "city", "admin_area", "country",
            "postal_code", "lat", "lng", "phone", "website", "source_url",
            "confidence_score", "status", "raw_source_data", "created_at",
            "updated_at", "last_seen",
        }
        app = build_app_values(columns, values)
        self.assertEqual(app["status"], "candidate")
        self.assertEqual(app["admin_area"], "Ontario")
        self.assertEqual(app["clinic_type"], "occupational medicine")
        self.assertEqual(app["services"], ["occupational medicine"])
        self.assertEqual(app["source_url"], "https://directory.example/central")
        self.assertEqual(app["source_kind"], "pasted_url_scrape")
        self.assertEqual(app["source_label"], "canada_registry")
        self.assertIsInstance(app["raw_source_data"], psycopg2.extras.Json)


if __name__ == "__main__":
    unittest.main()
