import hashlib
import json
import os
import re
from contextlib import contextmanager

import psycopg2
import psycopg2.extras

IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
APP_TABLE = os.getenv("APP_CANDIDATE_TABLE", "provider_candidates")


def normalize_text(value):
    return " ".join(str(value or "").replace("\xa0", " ").split()).strip()


def normalize_phone(value):
    digits = re.sub(r"\D+", "", str(value or ""))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits or None


def normalize_site(value):
    value = normalize_text(value)
    if not value:
        return None
    if value.startswith("//"):
        value = f"https:{value}"
    if not re.match(r"^https?://", value, re.I):
        value = f"https://{value}"
    return value


def normalized_name(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def dedupe_key(row):
    source_id = normalize_text(row.get("sourceUrl"))
    phone = normalize_phone(row.get("phone"))
    site = normalize_site(row.get("website"))
    name = normalized_name(row.get("name"))
    address = normalized_name(full_address(row))
    lat = row.get("lat")
    lng = row.get("lng")
    base = source_id or phone or site or f"{name}|{address}" or f"{name}|{lat}|{lng}"
    return hashlib.sha256(base.encode("utf-8")).hexdigest()


def full_address(row):
    address = normalize_text(row.get("address"))
    city = normalize_text(row.get("city"))
    state = normalize_text(row.get("state"))
    postal = normalize_text(row.get("postalCode"))
    if address and city and state:
        return ", ".join(part for part in [address, city, state, postal] if part)
    return address or ", ".join(part for part in [city, state, postal] if part)


def q(identifier):
    if not IDENTIFIER_RE.match(identifier or ""):
        raise ValueError(f"Invalid SQL identifier: {identifier}")
    return f'"{identifier}"'


@contextmanager
def connect():
    url = os.getenv("DATABASE_URL")
    if not url:
        yield None
        return
    conn = psycopg2.connect(url)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def table_exists(cur, table_name):
    cur.execute("SELECT to_regclass(%s) AS regclass", (f"public.{table_name}",))
    return bool(cur.fetchone()[0])


def table_columns(cur, table_name):
    cur.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s",
        (table_name,),
    )
    return {row[0] for row in cur.fetchall()}


def ensure_feeder_tables(cur):
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS google_maps_raw_results (
          id BIGSERIAL PRIMARY KEY,
          job_id BIGINT,
          query TEXT,
          country_code VARCHAR(2) DEFAULT 'US',
          title TEXT,
          category TEXT,
          categories JSONB,
          address TEXT,
          phone TEXT,
          website TEXT,
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          google_place_id TEXT,
          google_cid TEXT,
          review_rating DOUBLE PRECISION,
          review_count INTEGER,
          open_hours JSONB,
          raw JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS provider_feeder_candidates (
          id BIGSERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          country_code VARCHAR(2) NOT NULL DEFAULT 'US',
          category TEXT,
          address TEXT,
          phone TEXT,
          website TEXT,
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'new',
          dedupe_key TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_feeder_candidates_dedupe ON provider_feeder_candidates (dedupe_key)")


def row_to_values(row):
    name = normalize_text(row.get("name"))
    address = full_address(row)
    phone = normalize_phone(row.get("phone"))
    website = normalize_site(row.get("website"))
    state = normalize_text(row.get("state")).upper()[:2] or "US"
    lat = float(row["lat"]) if row.get("lat") not in (None, "") else None
    lng = float(row["lng"]) if row.get("lng") not in (None, "") else None
    services = normalize_text(row.get("services"))
    category = services or "clinic directory"
    source_type = normalize_text(row.get("sourceType")) or "scrapy_directory"
    source_tag = normalize_text(row.get("sourceTag")) or source_type
    raw = dict(row)
    raw["source"] = source_type
    raw["sourceTag"] = source_tag
    return {
        "name": name,
        "normalized_name": normalized_name(name),
        "country_code": "US",
        "state": state,
        "category": category,
        "address": address,
        "phone": phone,
        "website": website,
        "latitude": lat,
        "longitude": lng,
        "confidence_score": confidence_score(row),
        "dedupe_key": dedupe_key(row),
        "source_query": source_tag,
        "raw": raw,
    }


def confidence_score(row):
    score = 0.35
    if row.get("name"):
        score += 0.15
    if full_address(row):
        score += 0.2
    if row.get("phone"):
        score += 0.1
    if row.get("website") or row.get("sourceUrl"):
        score += 0.1
    if row.get("lat") and row.get("lng"):
        score += 0.1
    return min(score, 0.95)


def insert_raw(cur, values):
    cur.execute(
        """
        INSERT INTO google_maps_raw_results
          (query, country_code, title, category, categories, address, phone, website,
           latitude, longitude, raw)
        VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s::jsonb)
        RETURNING id
        """,
        (
            values["source_query"],
            values["country_code"],
            values["name"],
            values["category"],
            json.dumps([values["category"]]),
            values["address"],
            values["phone"],
            values["website"],
            values["latitude"],
            values["longitude"],
            json.dumps(values["raw"]),
        ),
    )
    return cur.fetchone()[0]


def upsert_feeder_candidate(cur, values):
    cur.execute("SELECT id FROM provider_feeder_candidates WHERE dedupe_key=%s", (values["dedupe_key"],))
    existing = cur.fetchone()
    if existing:
        cur.execute(
            """
            UPDATE provider_feeder_candidates
            SET address=COALESCE(address,%s), phone=COALESCE(phone,%s), website=COALESCE(website,%s),
                latitude=COALESCE(latitude,%s), longitude=COALESCE(longitude,%s),
                confidence_score=GREATEST(confidence_score,%s), updated_at=now()
            WHERE id=%s
            """,
            (values["address"], values["phone"], values["website"], values["latitude"], values["longitude"], values["confidence_score"], existing[0]),
        )
        return existing[0]
    cur.execute(
        """
        INSERT INTO provider_feeder_candidates
          (name, normalized_name, country_code, category, address, phone, website, latitude, longitude,
           confidence_score, status, dedupe_key)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'new',%s)
        RETURNING id
        """,
        (
            values["name"], values["normalized_name"], values["country_code"], values["category"], values["address"],
            values["phone"], values["website"], values["latitude"], values["longitude"], values["confidence_score"], values["dedupe_key"],
        ),
    )
    return cur.fetchone()[0]


def put_app_value(out, cols, names, value):
    if value in (None, ""):
        return
    for name in names:
        if name in cols:
            out[name] = value
            return


def upsert_app_candidate(cur, values):
    if os.getenv("ENABLE_APP_CANDIDATE_WRITE", "1") != "1":
        return "disabled"
    if not IDENTIFIER_RE.match(APP_TABLE):
        return "invalid_table"
    if not table_exists(cur, APP_TABLE):
        return "missing_table"
    cols = table_columns(cur, APP_TABLE)
    app = {}
    put_app_value(app, cols, ["name", "provider_name", "clinic_name", "title"], values["name"])
    put_app_value(app, cols, ["normalized_name", "normalized_provider_name", "search_name"], values["normalized_name"])
    put_app_value(app, cols, ["address", "full_address", "street_address"], values["address"])
    put_app_value(app, cols, ["phone", "phone_number"], values["phone"])
    put_app_value(app, cols, ["website", "url"], values["website"])
    put_app_value(app, cols, ["latitude", "lat"], values["latitude"])
    put_app_value(app, cols, ["longitude", "lng", "lon"], values["longitude"])
    put_app_value(app, cols, ["category", "provider_category", "primary_category", "service_line", "service_type"], values["category"])
    put_app_value(app, cols, ["dedupe_key", "external_key", "provider_key"], values["dedupe_key"])
    put_app_value(app, cols, ["source", "data_source", "created_by"], values["raw"].get("source", "scrapy_directory"))
    put_app_value(app, cols, ["source_query", "query"], values["source_query"])
    put_app_value(app, cols, ["confidence_score", "confidence"], values["confidence_score"])
    put_app_value(app, cols, ["raw", "raw_data", "metadata"], json.dumps(values["raw"]))
    if "status" in cols:
        app["status"] = "new"
    if "created_at" in cols:
        app["created_at"] = "__NOW__"
    if "updated_at" in cols:
        app["updated_at"] = "__NOW__"
    if not app:
        return "no_matching_columns"

    match_col = next((c for c in ["dedupe_key", "external_key", "provider_key", "phone", "phone_number", "website", "url"] if c in app and c in cols), None)
    table_sql = q(APP_TABLE)
    if match_col:
        cur.execute(f"SELECT {q('id') if 'id' in cols else '1'} FROM {table_sql} WHERE {q(match_col)}=%s LIMIT 1", (app[match_col],))
        existing = cur.fetchone()
        if existing and "id" in cols:
            updates = []
            params = []
            for col, val in app.items():
                if col in ("id", "created_at"):
                    continue
                if val == "__NOW__":
                    updates.append(f"{q(col)}=now()")
                elif col in ("confidence_score", "confidence"):
                    params.append(val)
                    updates.append(f"{q(col)}=GREATEST(COALESCE({q(col)},0),%s)")
                else:
                    params.append(val)
                    updates.append(f"{q(col)}=CASE WHEN {q(col)} IS NULL OR {q(col)}::text='' THEN %s ELSE {q(col)} END")
            params.append(existing[0])
            cur.execute(f"UPDATE {table_sql} SET {', '.join(updates)} WHERE {q('id')}=%s", params)
            return "updated"

    columns = []
    placeholders = []
    params = []
    for col, val in app.items():
        columns.append(q(col))
        if val == "__NOW__":
            placeholders.append("now()")
        else:
            placeholders.append("%s")
            params.append(val)
    cur.execute(f"INSERT INTO {table_sql} ({', '.join(columns)}) VALUES ({', '.join(placeholders)})", params)
    return "inserted"


def write_provider(row):
    values = row_to_values(row)
    if not values["name"]:
        return {"status": "skipped", "reason": "missing_name"}
    with connect() as conn:
        if conn is None:
            return {"status": "skipped", "reason": "DATABASE_URL_missing"}
        with conn.cursor() as cur:
            ensure_feeder_tables(cur)
            raw_id = insert_raw(cur, values)
            feeder_id = upsert_feeder_candidate(cur, values)
            app_status = upsert_app_candidate(cur, values)
            return {"status": "written", "raw_id": raw_id, "feeder_id": feeder_id, "app_status": app_status}
