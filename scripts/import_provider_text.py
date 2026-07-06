import argparse
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRAPERS = ROOT / "scrapers"
if str(SCRAPERS) not in sys.path:
    sys.path.insert(0, str(SCRAPERS))

from network_sources.db import write_provider

FIELDS = ["name", "address", "city", "state", "postalCode", "phone", "email", "website", "services", "sourceTag", "sourceUrl", "evidenceNote", "lat", "lng"]
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL_RE = re.compile(r"(?:https?://|www\.)[^\s;,)<]+", re.I)
PHONE_RE = re.compile(r"(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}")
ZIP_RE = re.compile(r"\b\d{5}(?:-\d{4})?\b")
STATE_RE = re.compile(r"\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b", re.I)
COORD_RE = re.compile(r"\b(-?\d{1,2}\.\d{3,})\s*[,| ]\s*(-?\d{2,3}\.\d{3,})\b")

CATEGORY_TERMS = [
    "occupational", "urgent care", "walk-in clinic", "clinic", "medical clinic", "medical center",
    "hospital", "doctor", "physician", "family practice", "family medicine", "primary care",
    "laboratory", "medical laboratory", "diagnostic", "imaging", "radiology", "x-ray",
    "spirometry", "audiogram", "drug testing", "dentist", "dental", "orthopedic",
    "cardiology", "pediatrician", "physical therapy", "chiropractor", "rehabilitation",
    "nursing home", "assisted living", "home health", "dialysis", "ambulance", "optometrist",
    "eye care", "surgery", "surgeon", "mental health", "counseling", "pharmacy",
]

NAME_TERMS = [
    "occupational", "urgent care", "clinic", "medical", "hospital", "health center", "family health",
    "rehabilitation", "nursing", "dental", "dentist", "orthopedic", "spine", "eye care", "pediatrics",
]

EXCLUDE = [
    "restaurant", "pizza", "hotel", "apartment", "salon", "spa", "veterinary", "animal hospital",
    "church", "school", "grocery", "gas station", "bank", "plumber", "photographer", "storage",
    "fireworks", "fire station", "recycling", "insurance", "rv park", "car dealer", "clothing store",
    "sunglasses", "beauty", "bridal", "tax", "movie", "soccer", "fishing", "flooring",
    "hardware", "cannabis", "cbd", "park", "real estate", "home builder", "lawyer", "attorney",
]

LABELS = {
    "name": ["name", "provider", "provider name", "business name", "facility", "clinic name", "title"],
    "address": ["address", "street", "location", "full address", "street address"],
    "city": ["city", "locality"],
    "state": ["state", "region", "province"],
    "postalCode": ["zip", "zipcode", "postal", "postal code"],
    "phone": ["phone", "phone number", "telephone", "tel", "mobile", "fax", "contact"],
    "email": ["email", "e-mail"],
    "website": ["website", "web", "site"],
    "sourceUrl": ["source url", "source_url", "maps url", "google maps url", "url"],
    "services": ["services", "service", "category", "categories", "specialty", "speciality", "type"],
    "lat": ["lat", "latitude"],
    "lng": ["lng", "lon", "longitude"],
}


def clean(value):
    if isinstance(value, list):
        return "; ".join(clean(x) for x in value if clean(x))
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return " ".join(str(value or "").replace("\u00a0", " ").replace("•", " ").split()).strip(" ,;|-\t\r\n")


def key(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value).lower()).strip()


def field_for(label):
    k = key(label)
    for field, labels in LABELS.items():
        if k in labels or any(k.startswith(x) for x in labels):
            return field
    return None


def has_term(text, terms):
    blob = f" {text.lower()} "
    return any(re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", blob) for term in terms)


def score(row):
    name = clean(row.get("name"))
    services = clean(row.get("services"))
    description = clean(row.get("description"))
    address = clean(row.get("address"))
    blob = f"{name} {services} {description}".lower()
    if has_term(blob, EXCLUDE):
        return -10

    value = 0
    if has_term(services, CATEGORY_TERMS):
        value += 6
    if has_term(name, NAME_TERMS):
        value += 4
    if has_term(description, ["medical", "clinic", "hospital", "dental", "rehabilitation"]):
        value += 2
    if address:
        value += 1
    if row.get("phone") or row.get("email") or row.get("website") or row.get("sourceUrl"):
        value += 1
    if row.get("lat") and row.get("lng"):
        value += 1
    return value


def likely_name(line):
    line = clean(line)
    if len(line) < 3 or len(line) > 140:
        return False
    if ":" in line and len(line.split(":", 1)[0]) <= 30:
        return False
    lower = line.lower()
    if has_term(lower, EXCLUDE):
        return False
    return has_term(lower, NAME_TERMS) or (bool(re.match(r"^[A-Z0-9][A-Za-z0-9 '&().,/+-]{2,120}$", line)) and len(line.split()) <= 12)


def add(row, field, value):
    value = clean(value)
    if not value:
        return
    if field == "state" and not STATE_RE.fullmatch(value):
        return
    if row.get(field):
        if value.lower() not in row[field].lower():
            row[field] += "; " + value
    else:
        row[field] = value


def derive_location_from_address(row):
    address = clean(row.get("address"))
    if not address:
        return
    postal = ZIP_RE.search(address)
    state = STATE_RE.search(address)
    if postal and not row.get("postalCode"):
        row["postalCode"] = postal.group(0)
    if state and not row.get("state"):
        row["state"] = state.group(1).upper()

    parts = [clean(x) for x in address.split(",") if clean(x)]
    for index, part in enumerate(parts):
        if STATE_RE.search(part) and index > 0 and not row.get("city"):
            row["city"] = parts[index - 1]
            break


def block_to_row(block, source_tag):
    lines = [clean(x) for x in block.splitlines() if clean(x)]
    if not lines:
        return None
    row = {field: "" for field in FIELDS}
    row["sourceTag"] = source_tag
    row["evidenceNote"] = block[:1500]

    for line in lines:
        m = re.match(r"^([A-Za-z][A-Za-z /_.-]{1,35})\s*[:=]\s*(.+)$", line)
        if m:
            field = field_for(m.group(1))
            if field:
                add(row, field, m.group(2))
                continue
        for item in EMAIL_RE.findall(line):
            add(row, "email", item)
        for item in URL_RE.findall(line):
            add(row, "sourceUrl" if "google.com/maps" in item else "website", item)
        for item in PHONE_RE.findall(line):
            add(row, "phone", item)
        coord = COORD_RE.search(line)
        if coord:
            add(row, "lat", coord.group(1))
            add(row, "lng", coord.group(2))
        if not row["name"] and likely_name(line):
            row["name"] = line
        elif not row["address"] and (ZIP_RE.search(line) or STATE_RE.search(line)) and any(ch.isdigit() for ch in line):
            row["address"] = line

    derive_location_from_address(row)
    if not row["services"]:
        found = [term for term in CATEGORY_TERMS if has_term(block, [term])]
        row["services"] = "; ".join(dict.fromkeys(found[:8])) or "provider text import"
    if not row["name"] or not (row["address"] or row["phone"] or row["email"] or row["website"] or row["sourceUrl"] or (row["lat"] and row["lng"])):
        return None
    if score(row) < 5:
        return None
    return row


def text_rows(path, source_tag):
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    if len(blocks) <= 1:
        blocks = []
        current = []
        for line in [clean(x) for x in text.splitlines() if clean(x)]:
            if current and likely_name(line):
                blocks.append("\n".join(current))
                current = [line]
            else:
                current.append(line)
        if current:
            blocks.append("\n".join(current))
    for block in blocks:
        row = block_to_row(block, source_tag)
        if row:
            yield row


def source_url_from(raw):
    for name in ["sourceUrl", "source_url", "maps_url", "url"]:
        value = clean(raw.get(name)) if isinstance(raw, dict) else ""
        if value:
            return value
    return ""


def normalize_structured(raw, source_tag):
    lower = {key(k): v for k, v in raw.items()}
    row = {field: "" for field in FIELDS}
    row["sourceTag"] = source_tag
    row["evidenceNote"] = json.dumps(raw, ensure_ascii=False)[:1500]
    row["sourceUrl"] = source_url_from(raw)

    for field, aliases in LABELS.items():
        if field in {"website", "sourceUrl"}:
            continue
        for alias in aliases:
            if alias in lower and lower[alias] not in (None, ""):
                row[field] = clean(lower[alias])
                break

    # Google Local / UCSD-style records use category as a list and latitude/longitude keys.
    if not row["services"] and "category" in raw:
        row["services"] = clean(raw.get("category"))
    if not row["lat"] and raw.get("latitude") not in (None, ""):
        row["lat"] = clean(raw.get("latitude"))
    if not row["lng"] and raw.get("longitude") not in (None, ""):
        row["lng"] = clean(raw.get("longitude"))
    if not row["website"]:
        for name in ["website", "site", "domain"]:
            if clean(raw.get(name)):
                row["website"] = clean(raw.get(name))
                break

    # Do not treat Google Local operational status as US state.
    if not STATE_RE.fullmatch(clean(row.get("state"))):
        row["state"] = ""
    derive_location_from_address(row)

    if not row["services"]:
        row["services"] = "imported provider data"
    return row if row["name"] and score(row) >= 5 else None


def structured_rows(path, source_tag, fmt):
    if fmt == "csv":
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            for raw in csv.DictReader(f):
                row = normalize_structured(raw, source_tag)
                if row:
                    yield row
    elif fmt == "jsonl":
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.strip():
                    row = normalize_structured(json.loads(line), source_tag)
                    if row:
                        yield row
    elif fmt == "json":
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        records = data if isinstance(data, list) else data.get("records", []) if isinstance(data, dict) else []
        for raw in records:
            if isinstance(raw, dict):
                row = normalize_structured(raw, source_tag)
                if row:
                    yield row


def detect(path, requested):
    if requested != "auto":
        return requested
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return "csv"
    if suffix == ".json":
        return "json"
    if suffix == ".jsonl":
        return "jsonl"
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("{"):
                return "jsonl"
            break
    return "txt"


def dedupe(rows):
    seen = set()
    out = []
    for row in rows:
        item = (row["name"].lower(), row["address"].lower(), row["phone"].lower(), row["website"].lower(), row["sourceUrl"].lower())
        if item not in seen:
            seen.add(item)
            out.append(row)
    return out


def save_csv(rows, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="Clean messy provider/location files and optionally import rows into Neon.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--format", choices=["auto", "txt", "csv", "json", "jsonl"], default="auto")
    parser.add_argument("--source-tag", default="provider_text_import")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    fmt = detect(args.input, args.format)
    rows = dedupe(text_rows(args.input, args.source_tag) if fmt == "txt" else structured_rows(args.input, args.source_tag, fmt))
    if args.out:
        save_csv(rows, args.out)
    written = skipped = 0
    if args.write:
        for row in rows:
            result = write_provider(row)
            if result.get("status") == "written":
                written += 1
            else:
                skipped += 1
    print(f"Detected format: {fmt}")
    print(f"Provider-looking rows: {len(rows):,}")
    if args.out:
        print(f"Saved cleaned CSV: {args.out}")
    if args.write:
        print(f"Written: {written:,}")
        print(f"Skipped: {skipped:,}")


if __name__ == "__main__":
    main()
