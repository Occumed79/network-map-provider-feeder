import hashlib
import json
import os
import re

import psycopg2
import psycopg2.extras

IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
APP_TABLE = os.getenv("APP_CANDIDATE_TABLE", "provider_candidates")
US_REGIONS = set("AL AK AZ AR CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY".split())
COUNTRY_ALIASES = {
    "united states": "US", "united states of america": "US", "usa": "US", "canada": "CA",
    "mexico": "MX", "united kingdom": "GB", "uk": "GB", "australia": "AU", "new zealand": "NZ",
    "ireland": "IE", "france": "FR", "germany": "DE", "italy": "IT", "spain": "ES",
    "portugal": "PT", "netherlands": "NL", "belgium": "BE", "switzerland": "CH", "austria": "AT",
    "norway": "NO", "sweden": "SE", "finland": "FI", "denmark": "DK", "poland": "PL",
    "czech republic": "CZ", "czechia": "CZ", "romania": "RO", "greece": "GR", "turkey": "TR",
    "israel": "IL", "lebanon": "LB", "jordan": "JO", "saudi arabia": "SA",
    "united arab emirates": "AE", "uae": "AE", "qatar": "QA", "bahrain": "BH", "kuwait": "KW",
    "oman": "OM", "egypt": "EG", "south africa": "ZA", "ghana": "GH", "nigeria": "NG",
    "kenya": "KE", "ethiopia": "ET", "morocco": "MA", "india": "IN", "pakistan": "PK",
    "bangladesh": "BD", "sri lanka": "LK", "china": "CN", "japan": "JP", "south korea": "KR",
    "philippines": "PH", "singapore": "SG", "malaysia": "MY", "thailand": "TH", "vietnam": "VN",
    "indonesia": "ID", "brazil": "BR", "argentina": "AR", "chile": "CL", "peru": "PE",
    "colombia": "CO", "costa rica": "CR", "panama": "PA",
}


def clean(value):
    return " ".join(str(value or "").replace("\xa0", " ").split()).strip()


def normalized_name(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def normalize_phone(value):
    raw = clean(value)
    if not raw:
        return None
    digits = re.sub(r"\D+", "", raw)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits or raw


def normalize_site(value):
    value = clean(value)
    if not value:
        return None
    if value.startswith("//"):
        value = f"https:{value}"
    return value if re.match(r"^https?://", value, re.I) else f"https://{value}"


def normalize_country(row):
    code = clean(row.get("countryCode") or row.get("country_code"))
    name = clean(row.get("country") or row.get("countryName"))
    region = clean(row.get("region") or row.get("state") or row.get("province"))
    if len(code) == 2 and code.isalpha():
        return code.upper(), name or code.upper()
    if name:
        if len(name) == 2 and name.isalpha():
            return name.upper(), name.upper()
        return COUNTRY_ALIASES.get(name.lower(), "XX"), name
    if region.upper() in US_REGIONS:
        return "US", "United States"
    return "XX", "Unknown"


def full_address(row):
    parts = [
        clean(row.get("address")), clean(row.get("city")),
        clean(row.get("region") or row.get("state") or row.get("province")),
        clean(row.get("postalCode") or row.get("postal_code")), clean(row.get("country")),
    ]
    out = []
    for part in parts:
        if part and part.lower() not in {item.lower() for item in out}:
            out.append(part)
    return ", ".join(out)


def q(identifier):
    if not IDENTIFIER_RE.match(identifier or ""):
        raise ValueError(f"Invalid SQL identifier: {identifier}")
    return f'"{identifier}"'


def open_connection():
    url = os.getenv("DATABASE_URL")
    return psycopg2.connect(url) if url else None


def table_exists(cur, table):
    cur.execute("SELECT to_regclass(%s)", (f"public.{table}",))
    return bool(cur.fetchone()[0])


def table_columns(cur, table):
    cur.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s", (table,))
    return {row[0] for row in cur.fetchall()}


def ensure_feeder_tables(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS google_maps_raw_results (
          id BIGSERIAL PRIMARY KEY, job_id BIGINT, query TEXT, country_code VARCHAR(2) DEFAULT 'XX',
          title TEXT, category TEXT, categories JSONB, address TEXT, phone TEXT, website TEXT,
          latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, google_place_id TEXT, google_cid TEXT,
          review_rating DOUBLE PRECISION, review_count INTEGER, open_hours JSONB, raw JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS provider_feeder_candidates (
          id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
          country_code VARCHAR(2) NOT NULL DEFAULT 'XX', country TEXT, city TEXT, region TEXT,
          postal_code TEXT, category TEXT, address TEXT, phone TEXT, website TEXT,
          latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'new', dedupe_key TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())
    """)
    for sql in (
        "ALTER TABLE provider_feeder_candidates ADD COLUMN IF NOT EXISTS country TEXT",
        "ALTER TABLE provider_feeder_candidates ADD COLUMN IF NOT EXISTS city TEXT",
        "ALTER TABLE provider_feeder_candidates ADD COLUMN IF NOT EXISTS region TEXT",
        "ALTER TABLE provider_feeder_candidates ADD COLUMN IF NOT EXISTS postal_code TEXT",
    ):
        cur.execute(sql)
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_feeder_candidates_dedupe ON provider_feeder_candidates(dedupe_key)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS provider_feeder_crawl_runs (
          run_key TEXT PRIMARY KEY, mode TEXT NOT NULL, start_url TEXT, status TEXT NOT NULL DEFAULT 'running',
          config JSONB NOT NULL DEFAULT '{}'::jsonb, pages_crawled INTEGER NOT NULL DEFAULT 0,
          providers_found INTEGER NOT NULL DEFAULT 0, providers_written INTEGER NOT NULL DEFAULT 0,
          last_url TEXT, last_error TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ)
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS provider_feeder_crawl_pages (
          run_key TEXT NOT NULL REFERENCES provider_feeder_crawl_runs(run_key) ON DELETE CASCADE,
          url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', depth INTEGER NOT NULL DEFAULT 0,
          parent_url TEXT, country TEXT, source_tag TEXT, providers_found INTEGER NOT NULL DEFAULT 0,
          http_status INTEGER, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY(run_key,url))
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_crawl_pages_status ON provider_feeder_crawl_pages(run_key,status,depth,updated_at)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_crawl_runs_status ON provider_feeder_crawl_runs(status,updated_at DESC)")


def confidence_score(row):
    score = 0.30 + (0.20 if row.get("name") else 0) + (0.20 if full_address(row) else 0)
    score += 0.10 if row.get("phone") or row.get("email") else 0
    score += 0.10 if row.get("website") or row.get("sourceUrl") else 0
    score += 0.10 if row.get("lat") and row.get("lng") else 0
    return min(score, 0.95)


def row_values(row):
    country_code, country = normalize_country(row)
    name = clean(row.get("name"))
    address = full_address(row)
    phone = normalize_phone(row.get("phone"))
    website = normalize_site(row.get("website"))
    city = clean(row.get("city"))
    region = clean(row.get("region") or row.get("state") or row.get("province"))
    postal = clean(row.get("postalCode") or row.get("postal_code"))
    source_type = clean(row.get("sourceType")) or "scrapy_directory"
    source_tag = clean(row.get("sourceTag")) or source_type
    raw = dict(row)
    raw.update(source=source_type, sourceTag=source_tag)
    base = clean(row.get("sourceUrl")) or phone or website or f"{normalized_name(name)}|{normalized_name(address)}"
    return {
        "name": name, "normalized_name": normalized_name(name), "country_code": country_code,
        "country": country, "city": city, "region": region, "postal_code": postal,
        "category": clean(row.get("services")) or "healthcare provider", "address": address,
        "phone": phone, "website": website,
        "latitude": float(row["lat"]) if row.get("lat") not in (None, "") else None,
        "longitude": float(row["lng"]) if row.get("lng") not in (None, "") else None,
        "confidence_score": confidence_score(row), "dedupe_key": hashlib.sha256(base.encode()).hexdigest(),
        "source_query": source_tag, "raw": raw, "crawl_run_key": clean(row.get("crawlRunKey")),
    }


def insert_raw(cur, v):
    cur.execute("""
        INSERT INTO google_maps_raw_results
          (query,country_code,title,category,categories,address,phone,website,latitude,longitude,raw)
        VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s::jsonb) RETURNING id
    """, (v["source_query"], v["country_code"], v["name"], v["category"], json.dumps([v["category"]]),
          v["address"], v["phone"], v["website"], v["latitude"], v["longitude"], json.dumps(v["raw"])))
    return cur.fetchone()[0]


def upsert_staging(cur, v):
    cur.execute("SELECT id FROM provider_feeder_candidates WHERE dedupe_key=%s", (v["dedupe_key"],))
    row = cur.fetchone()
    if row:
        cur.execute("""
            UPDATE provider_feeder_candidates SET
              country_code=CASE WHEN country_code IN ('US','XX') AND %s<>'XX' THEN %s ELSE country_code END,
              country=COALESCE(NULLIF(country,''),%s), city=COALESCE(NULLIF(city,''),%s),
              region=COALESCE(NULLIF(region,''),%s), postal_code=COALESCE(NULLIF(postal_code,''),%s),
              address=COALESCE(NULLIF(address,''),%s), phone=COALESCE(NULLIF(phone,''),%s),
              website=COALESCE(NULLIF(website,''),%s), latitude=COALESCE(latitude,%s),
              longitude=COALESCE(longitude,%s), confidence_score=GREATEST(confidence_score,%s), updated_at=now()
            WHERE id=%s
        """, (v["country_code"], v["country_code"], v["country"], v["city"], v["region"], v["postal_code"],
              v["address"], v["phone"], v["website"], v["latitude"], v["longitude"], v["confidence_score"], row[0]))
        return row[0]
    cur.execute("""
        INSERT INTO provider_feeder_candidates
          (name,normalized_name,country_code,country,city,region,postal_code,category,address,phone,website,
           latitude,longitude,confidence_score,status,dedupe_key)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'new',%s) RETURNING id
    """, (v["name"], v["normalized_name"], v["country_code"], v["country"], v["city"], v["region"],
          v["postal_code"], v["category"], v["address"], v["phone"], v["website"], v["latitude"],
          v["longitude"], v["confidence_score"], v["dedupe_key"]))
    return cur.fetchone()[0]


def put(out, cols, names, value):
    if value in (None, ""):
        return
    for name in names:
        if name in cols:
            out[name] = value
            return


def build_app_values(cols, v):
    app = {}
    service_values = [v["category"]] if v.get("category") else []
    mappings = [
        (["name", "provider_name", "clinic_name", "title"], v["name"]),
        (["normalized_name", "normalized_provider_name", "search_name"], v["normalized_name"]),
        (["source_kind"], v["raw"].get("source") or "provider_feeder"),
        (["source_label"], v["source_query"] or "Provider feeder"),
        (["address", "full_address", "street_address"], v["address"]),
        (["city", "locality"], v["city"]),
        (["admin_area", "state", "region", "province", "administrative_area"], v["region"]),
        (["postal_code", "postalCode", "zip", "zipcode"], v["postal_code"]),
        (["country", "country_name"], v["country"]),
        (["country_code", "countryCode"], v["country_code"]),
        (["phone", "phone_number"], v["phone"]),
        (["website", "url"], v["website"]),
        (["source_url"], clean(v["raw"].get("sourceUrl"))),
        (["latitude", "lat"], v["latitude"]),
        (["longitude", "lng", "lon"], v["longitude"]),
        (["clinic_type", "category", "provider_category", "primary_category", "service_line", "service_type"], v["category"]),
        (["services"], service_values),
        (["categories"], service_values),
        (["dedupe_key", "external_key", "provider_key"], v["dedupe_key"]),
        (["source", "data_source", "created_by"], v["raw"].get("source")),
        (["source_query", "query"], v["source_query"]),
        (["confidence_score", "confidence"], v["confidence_score"]),
        (["raw_source_data", "raw", "raw_data", "metadata"], psycopg2.extras.Json(v["raw"])),
    ]
    for names, value in mappings:
        put(app, cols, names, value)
    if "status" in cols:
        app["status"] = "candidate"
    if "created_at" in cols:
        app["created_at"] = "__NOW__"
    if "updated_at" in cols:
        app["updated_at"] = "__NOW__"
    if "last_seen" in cols:
        app["last_seen"] = "__NOW__"
    return app


def upsert_app(cur, v):
    if os.getenv("ENABLE_APP_CANDIDATE_WRITE", "1") != "1":
        return "disabled"
    if not IDENTIFIER_RE.match(APP_TABLE) or not table_exists(cur, APP_TABLE):
        return "missing_table"
    cols = table_columns(cur, APP_TABLE)
    app = build_app_values(cols, v)
    if not app:
        return "no_matching_columns"
    existing = None
    for match in ("dedupe_key", "external_key", "provider_key", "source_url", "phone", "phone_number", "website", "url"):
        if match not in app:
            continue
        cur.execute(f"SELECT {q('id') if 'id' in cols else '1'} FROM {q(APP_TABLE)} WHERE {q(match)}=%s LIMIT 1", (app[match],))
        existing = cur.fetchone()
        if existing:
            break
    if not existing and all(name in app and name in cols for name in ("normalized_name", "address")):
        cur.execute(
            f"SELECT {q('id') if 'id' in cols else '1'} FROM {q(APP_TABLE)} WHERE lower({q('normalized_name')})=lower(%s) AND lower({q('address')})=lower(%s) LIMIT 1",
            (app["normalized_name"], app["address"]),
        )
        existing = cur.fetchone()
    if existing and "id" in cols:
        sets, params = [], []
        for col, value in app.items():
            if col in ("id", "created_at"):
                continue
            if value == "__NOW__":
                sets.append(f"{q(col)}=now()")
            else:
                params.append(value)
                if col in ("confidence_score", "confidence"):
                    sets.append(f"{q(col)}=GREATEST(COALESCE({q(col)},0),%s)")
                else:
                    sets.append(f"{q(col)}=CASE WHEN {q(col)} IS NULL OR {q(col)}::text='' THEN %s ELSE {q(col)} END")
        params.append(existing[0])
        cur.execute(f"UPDATE {q(APP_TABLE)} SET {', '.join(sets)} WHERE {q('id')}=%s", params)
        return "updated"
    names, placeholders, params = [], [], []
    for col, value in app.items():
        names.append(q(col))
        if value == "__NOW__":
            placeholders.append("now()")
        else:
            params.append(value)
            placeholders.append("%s")
    cur.execute(f"INSERT INTO {q(APP_TABLE)} ({', '.join(names)}) VALUES ({', '.join(placeholders)})", params)
    return "inserted"


def write_provider(row, conn=None, commit=None, ensure_schema=True):
    v = row_values(row)
    if not v["name"]:
        return {"status": "skipped", "reason": "missing_name"}
    own = conn is None
    conn = conn or open_connection()
    if conn is None:
        return {"status": "skipped", "reason": "DATABASE_URL_missing"}
    commit = own if commit is None else commit
    try:
        with conn.cursor() as cur:
            if ensure_schema:
                ensure_feeder_tables(cur)
            raw_id = insert_raw(cur, v)
            feeder_id = upsert_staging(cur, v)
            app_status = upsert_app(cur, v)
            if v["crawl_run_key"] and app_status in {"inserted", "updated"}:
                cur.execute("UPDATE provider_feeder_crawl_runs SET providers_written=providers_written+1,updated_at=now() WHERE run_key=%s", (v["crawl_run_key"],))
        if commit:
            conn.commit()
        return {"status": "written", "raw_id": raw_id, "feeder_id": feeder_id, "app_status": app_status}
    except Exception:
        if commit:
            conn.rollback()
        raise
    finally:
        if own:
            conn.close()


class CrawlCheckpointStore:
    def __init__(self):
        self.conn = open_connection()
        self.pending_writes = 0
        if self.conn:
            with self.conn.cursor() as cur:
                ensure_feeder_tables(cur)
            self.conn.commit()

    def start_run(self, key, mode, start_url, config):
        if not self.conn or not key:
            return
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO provider_feeder_crawl_runs(run_key,mode,start_url,status,config,started_at,updated_at,completed_at,last_error)
                VALUES (%s,%s,%s,'running',%s::jsonb,now(),now(),NULL,NULL)
                ON CONFLICT(run_key) DO UPDATE SET status='running',config=EXCLUDED.config,updated_at=now(),completed_at=NULL,last_error=NULL
            """, (key, mode, start_url, json.dumps(config or {})))
        self.conn.commit()

    def load(self, key, limit=20000):
        if not self.conn or not key:
            return {"processed": set(), "pending": []}
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT url,status,depth,parent_url,country,source_tag FROM provider_feeder_crawl_pages WHERE run_key=%s ORDER BY depth,updated_at LIMIT %s", (key, limit))
            rows = list(cur.fetchall())
        return {
            "processed": {row["url"] for row in rows if row["status"] == "processed"},
            "pending": [dict(row) for row in rows if row["status"] in {"pending", "failed", "processing"}],
        }

    def queue(self, key, url, depth=0, parent=None, country=None, tag=None):
        if not key or not url:
            return False
        if not self.conn:
            return True
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO provider_feeder_crawl_pages(run_key,url,status,depth,parent_url,country,source_tag,updated_at)
                VALUES (%s,%s,'pending',%s,%s,%s,%s,now()) ON CONFLICT(run_key,url) DO NOTHING RETURNING url
            """, (key, url, depth, parent, country, tag))
            inserted = bool(cur.fetchone())
        self.pending_writes += 1
        if self.pending_writes >= 50:
            self.flush()
        return inserted

    def flush(self):
        if self.conn and self.pending_writes:
            self.conn.commit()
            self.pending_writes = 0

    def mark(self, key, url, status, depth=0, found=0, http_status=None, error=None):
        if not self.conn or not key or not url:
            return
        with self.conn.cursor() as cur:
            cur.execute("""
                UPDATE provider_feeder_crawl_pages SET status=%s,depth=%s,providers_found=%s,http_status=%s,last_error=%s,updated_at=now()
                WHERE run_key=%s AND url=%s
            """, (status, depth, found, http_status, error, key, url))
            if status == "processed":
                cur.execute("UPDATE provider_feeder_crawl_runs SET pages_crawled=pages_crawled+1,providers_found=providers_found+%s,last_url=%s,updated_at=now() WHERE run_key=%s", (found, url, key))
            elif error:
                cur.execute("UPDATE provider_feeder_crawl_runs SET last_url=%s,last_error=%s,updated_at=now() WHERE run_key=%s", (url, str(error)[:1500], key))
        self.conn.commit()
        self.pending_writes = 0

    def finish(self, key, status, error=None):
        if not self.conn or not key:
            return
        with self.conn.cursor() as cur:
            cur.execute("""
                UPDATE provider_feeder_crawl_runs SET status=%s,last_error=%s,updated_at=now(),
                  completed_at=CASE WHEN %s='completed' THEN now() ELSE completed_at END WHERE run_key=%s
            """, (status, error, status, key))
        self.conn.commit()

    def close(self):
        if self.conn:
            try:
                self.conn.commit()
            finally:
                self.conn.close()
                self.conn = None
