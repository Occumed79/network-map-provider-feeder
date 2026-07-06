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

HEALTH = ["occupational", "urgent care", "clinic", "medical", "health", "hospital", "doctor", "physician", "laboratory", "lab", "diagnostic", "imaging", "radiology", "x-ray", "spirometry", "audiogram", "drug testing", "dental", "rehab"]
EXCLUDE = ["restaurant", "hotel", "apartment", "salon", "spa", "veterinary", "church", "school", "grocery", "gas station", "bank"]

LABELS = {
    "name": ["name", "provider", "provider name", "business name", "facility", "clinic name"],
    "address": ["address", "street", "location", "full address"],
    "city": ["city", "locality"],
    "state": ["state", "region", "province"],
    "postalCode": ["zip", "zipcode", "postal", "postal code"],
    "phone": ["phone", "telephone", "tel", "mobile", "fax", "contact"],
    "email": ["email", "e-mail"],
    "website": ["website", "web", "url", "site"],
    "services": ["services", "category", "categories", "specialty", "speciality", "type"],
    "lat": ["lat", "latitude"],
    "lng": ["lng", "lon", "longitude"],
}


def clean(value):
    return " ".join(str(value or "").replace("\u00a0", " ").replace("•", " ").split()).strip(" ,;|-\t\r\n")


def key(value):
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def field_for(label):
    k = key(label)
    for field, labels in LABELS.items():
        if k in labels or any(k.startswith(x) for x in labels):
            return field
    return None


def score(row):
    blob = " ".join(clean(row.get(k)) for k in ["name", "services", "address", "evidenceNote", "website"]).lower()
    value = 0
    for term in HEALTH:
        if term in blob:
            value += 2
    for term in EXCLUDE:
        if term in blob:
            value -= 5
    if row.get("address"):
        value += 2
    if row.get("phone") or row.get("email") or row.get("website"):
        value += 1
    return value


def likely_name(line):
    line = clean(line)
    if len(line) < 3 or len(line) > 140:
        return False
    if ":" in line and len(line.split(":", 1)[0]) <= 30:
        return False
    lower = line.lower()
    if any(x in lower for x in EXCLUDE):
        return False
    return any(x in lower for x in HEALTH) or (bool(re.match(r"^[A-Z0-9][A-Za-z0-9 '&().,/+-]{2,120}$", line)) and len(line.split()) <= 12)


def add(row, field, value):
    value = clean(value)
    if not value:
        return
    if row.get(field):
        if value.lower() not in row[field].lower():
            row[field] += "; " + value
    else:
        row[field] = value


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
            add(row, "website", item)
        for item in PHONE_RE.findall(line):
            add(row, "phone", item)
        coord = COORD_RE.search(line)
        if coord:
            add(row, "lat", coord.group(1))
            add(row, "lng", coord.group(2))
        z = ZIP_RE.search(line)
        s = STATE_RE.search(line)
        if z:
            add(row, "postalCode", z.group(0))
        if s:
            add(row, "state", s.group(1).upper())
        if not row["name"] and likely_name(line):
            row["name"] = line
        elif not row["address"] and (z or s) and any(ch.isdigit() for ch in line):
            row["address"] = line

    if not row["services"]:
        found = [term for term in HEALTH if term in block.lower()]
        row["services"] = "; ".join(dict.fromkeys(found[:8])) or "provider text import"
    if not row["name"] or not (row["address"] or row["phone"] or row["email"] or row["website"] or (row["lat"] and row["lng"])):
        return None
    if score(row) < 3:
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


def structured_rows(path, source_tag, fmt):
    def normalize(raw):
        lower = {key(k): v for k, v in raw.items()}
        row = {field: "" for field in FIELDS}
        row["sourceTag"] = source_tag
        row["evidenceNote"] = json.dumps(raw, ensure_ascii=False)[:1500]
        for field, aliases in LABELS.items():
            for alias in aliases:
                if alias in lower:
                    row[field] = clean(lower[alias])
                    break
        if not row["services"]:
            row["services"] = "imported provider data"
        return row if row["name"] and score(row) >= 2 else None

    if fmt == "csv":
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            for raw in csv.DictReader(f):
                row = normalize(raw)
                if row:
                    yield row
    elif fmt == "jsonl":
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.strip():
                    row = normalize(json.loads(line))
                    if row:
                        yield row
    elif fmt == "json":
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        records = data if isinstance(data, list) else data.get("records", []) if isinstance(data, dict) else []
        for raw in records:
            if isinstance(raw, dict):
                row = normalize(raw)
                if row:
                    yield row


def detect(path, requested):
    if requested != "auto":
        return requested
    return {".csv": "csv", ".json": "json", ".jsonl": "jsonl"}.get(path.suffix.lower(), "txt")


def dedupe(rows):
    seen = set()
    out = []
    for row in rows:
        item = (row["name"].lower(), row["address"].lower(), row["phone"].lower(), row["website"].lower())
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
