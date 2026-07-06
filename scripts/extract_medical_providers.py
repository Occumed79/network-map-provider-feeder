import csv, re, sys
from pathlib import Path
try:
    import fitz
except ImportError as exc:
    raise SystemExit('PyMuPDF is required: pip install pymupdf') from exc
FIELDS='country,city,category,provider_name,provider_type,specialty,address,phone,email,website,hours'.split(',')
PHONE=re.compile(r'(?:\+?\d[\d\s().-]{7,}\d)'); EMAIL=re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'); WEB=re.compile(r'(?:https?://|www\.)\S+')
def clean(x): return ' '.join((x or '').replace('\xa0',' ').split()).strip(' ,;')
def main():
    if len(sys.argv)<3: raise SystemExit('usage: extract_medical_providers.py input.pdf output.csv')
    inp,out=Path(sys.argv[1]),Path(sys.argv[2]); rows=[]
    doc=fitz.open(inp)
    for page in doc:
        lines=[clean(x) for x in page.get_text().splitlines() if clean(x)]
        for i,line in enumerate(lines):
            blob=' '.join(lines[i:i+5]); low=blob.lower()
            if not any(t in low for t in ['clinic','hospital','medical','doctor','physician','dentist','health','laboratory','rehabilitation']): continue
            ph=PHONE.search(blob); em=EMAIL.search(blob); web=WEB.search(blob)
            if not (ph or em or web): continue
            rows.append({'country':'','city':'','category':'medical provider directory','provider_name':line[:160],'provider_type':'','specialty':'','address':blob[:500],'phone':ph.group(0) if ph else '','email':em.group(0) if em else '','website':web.group(0) if web else '','hours':''})
    out.parent.mkdir(parents=True,exist_ok=True)
    with out.open('w',encoding='utf-8-sig',newline='') as f: w=csv.DictWriter(f,fieldnames=FIELDS); w.writeheader(); w.writerows(rows)
    print(f'Extracted {len(rows)} provider-looking rows to {out}')
if __name__=='__main__': main()
