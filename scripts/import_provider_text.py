import argparse, csv, json, os, re, sys
from collections import Counter
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; SCRAPERS=ROOT/'scrapers'; sys.path.insert(0,str(SCRAPERS))
from network_sources.db import write_provider
ACCEPTED_FIELDS='name,address,city,state,postalCode,phone,email,website,services,sourceType,sourceTag,sourceUrl,lat,lng,score,match_reasons'.split(',')
REJECTED_FIELDS='name,address,city,state,postalCode,phone,website,services,sourceUrl,score,rejection_reason,evidenceNote'.split(',')
EMAIL_RE=re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"); URL_RE=re.compile(r"(?:https?://|www\.)[^\s;,)<]+",re.I); PHONE_RE=re.compile(r"(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}"); ZIP_RE=re.compile(r"\b\d{5}(?:-\d{4})?\b"); STATE_RE=re.compile(r"\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b",re.I)
ACCEPT='occupational,occupational medicine,employee health,urgent care,walk-in clinic,clinic,medical clinic,medical center,hospital,doctor,physician,family practice,family medicine,primary care,laboratory,medical laboratory,diagnostic,imaging,radiology,x-ray,spirometry,audiogram,drug testing,dentist,dental,orthopedic,cardiology,physical therapy,rehabilitation,nursing home,home health,dialysis,ambulance,optometrist,eye care,surgery,surgeon,mental health,counseling,pharmacy'.split(',')
REJECT='restaurant,pizza,hotel,apartment,salon,spa,veterinary,animal hospital,church,school,grocery,gas station,bank,plumber,photographer,storage,fireworks,fire station,recycling,insurance,rv park,car dealer,clothing store,sunglasses,beauty,bridal,tax,movie,soccer,fishing,flooring,hardware,cannabis,cbd,park,real estate,home builder,lawyer,attorney,boutique'.split(',')
LABELS={'name':['name','provider_name','provider','business name','facility','title'],'address':['address','full_address','street_address','street','location'],'city':['city','locality'],'state':['state','region','province'],'postalCode':['zip','zipcode','postal','postal code'],'phone':['phone','phone_number','telephone','tel'],'email':['email','e-mail'],'website':['website','site','domain'],'sourceUrl':['sourceurl','source_url','maps url','google maps url','url'],'services':['services','service','category','categories','specialty','speciality','provider_type','type'],'lat':['lat','latitude'],'lng':['lng','lon','longitude']}

def clean(v):
    if isinstance(v,list): return '; '.join(clean(x) for x in v if clean(x))
    if isinstance(v,dict): return json.dumps(v,ensure_ascii=False)
    return ' '.join(str(v or '').replace('\xa0',' ').replace('•',' ').split()).strip(' ,;|\t\r\n')
def norm(v): return re.sub(r'[^a-z0-9]+',' ',str(v).lower()).strip()
def has(text,terms):
    b=' '+(text or '').lower()+' '; return [t for t in terms if re.search(rf'(?<![a-z0-9]){re.escape(t)}(?![a-z0-9])',b)]
def empty_row(source_type,source_tag): return {k:'' for k in ACCEPTED_FIELDS+['evidenceNote','rejection_reason'] }|{'sourceType':source_type,'sourceTag':source_tag}
def add(row,k,v):
    v=clean(v)
    if v and not row.get(k): row[k]=v
def source_url(raw):
    for k in ['sourceUrl','source_url','maps_url','url']:
        v=clean(raw.get(k,''))
        if v and ('google.com/maps' in v or k!='url'): return v
    return ''
def derive(row):
    addr=clean(row.get('address'))
    if not addr: return
    # strip duplicated business name prefix
    nm=clean(row.get('name'))
    if nm and addr.lower().startswith(nm.lower()+','): row['address']=addr[len(nm)+1:].strip(); addr=row['address']
    z=ZIP_RE.search(addr); st=STATE_RE.search(addr)
    if z and not row.get('postalCode'): row['postalCode']=z.group(0)
    if st and not row.get('state'): row['state']=st.group(1).upper()
    parts=[clean(x) for x in addr.split(',') if clean(x)]
    for i,p in enumerate(parts):
        if STATE_RE.search(p) and i>0 and not row.get('city'): row['city']=parts[i-1]
def score_row(row):
    blob=f"{row.get('name','')} {row.get('services','')} {row.get('evidenceNote','')}"; rejects=has(blob,REJECT)
    if rejects: return -10,[f'reject:{r}' for r in rejects],'excluded business category'
    reasons=[]; score=0; a=has(row.get('services',''),ACCEPT); n=has(row.get('name',''),ACCEPT); e=has(row.get('evidenceNote',''),ACCEPT)
    if a: score+=6; reasons += [f'service:{x}' for x in a[:5]]
    if n: score+=4; reasons += [f'name:{x}' for x in n[:3]]
    if e: score+=2; reasons += [f'evidence:{x}' for x in e[:3]]
    if row.get('address') or (row.get('lat') and row.get('lng')): score+=1; reasons.append('location evidence')
    if row.get('phone') or row.get('email') or row.get('website') or row.get('sourceUrl'): score+=1; reasons.append('contact/source evidence')
    if not row.get('name'): return score,reasons,'missing name'
    if not (row.get('address') or row.get('phone') or row.get('email') or row.get('website') or row.get('sourceUrl') or row.get('lat')): return score,reasons,'missing location/contact/source evidence'
    return score,reasons,'below min score'
def normalize_structured(raw,source_type,source_tag):
    lower={norm(k):v for k,v in raw.items()}; row=empty_row(clean(raw.get('sourceType')) or source_type, clean(raw.get('sourceTag')) or source_tag); row['evidenceNote']=json.dumps(raw,ensure_ascii=False)[:1500]; row['sourceUrl']=source_url(raw)
    for field,aliases in LABELS.items():
        if field=='sourceUrl': continue
        for alias in aliases:
            if norm(alias) in lower and lower[norm(alias)] not in (None,''):
                val=clean(lower[norm(alias)])
                row[field] = (row.get(field) + '; ' + val).strip('; ') if field == 'services' and row.get(field) and val.lower() not in row.get(field,'').lower() else val
                if field != 'services': break
    if not row['services'] and raw.get('category'): row['services']=clean(raw.get('category'))
    if not row['lat'] and raw.get('latitude') not in (None,''): row['lat']=clean(raw.get('latitude'))
    if not row['lng'] and raw.get('longitude') not in (None,''): row['lng']=clean(raw.get('longitude'))
    if row.get('sourceUrl','').startswith('https://www.google.com/maps') and row.get('website')==row.get('sourceUrl'): row['website']=''
    if not STATE_RE.fullmatch(clean(row.get('state'))): row['state']=''
    derive(row); return row
def block_row(block,source_type,source_tag):
    row=empty_row(source_type,source_tag); row['evidenceNote']=block[:1500]; lines=[clean(x) for x in block.splitlines() if clean(x)]
    if lines: row['name']=lines[0]
    for line in lines:
        m=re.match(r'^([A-Za-z][A-Za-z /_.-]{1,35})\s*[:=]\s*(.+)$',line)
        if m:
            f=next((k for k,a in LABELS.items() if norm(m.group(1)) in [norm(x) for x in a]),None)
            if f: add(row,f,m.group(2)); continue
        for x in EMAIL_RE.findall(line): add(row,'email',x)
        for x in URL_RE.findall(line): add(row,'sourceUrl' if 'google.com/maps' in x else 'website',x)
        for x in PHONE_RE.findall(line): add(row,'phone',x)
        if not row['address'] and (ZIP_RE.search(line) or STATE_RE.search(line)) and any(c.isdigit() for c in line): row['address']=line
    found=has(block,ACCEPT); row['services']=row['services'] or '; '.join(found[:6])
    derive(row); return row
def detect(path,requested):
    if requested!='auto': return requested
    if path.suffix.lower()=='.csv': return 'csv'
    if path.suffix.lower()=='.json': return 'json'
    if path.suffix.lower()=='.jsonl': return 'jsonl'
    for line in path.read_text(encoding='utf-8',errors='replace').splitlines():
        if line.strip():
            if line.lstrip().startswith('{'): return 'jsonl'
            break
    return 'txt'
def read_rows(path,fmt,source_type,source_tag,limit=None):
    n=0
    def emit(r):
        nonlocal n
        if limit and n>=limit: return None
        n+=1; return r
    if fmt=='csv':
        with path.open(encoding='utf-8-sig',newline='') as f:
            for raw in csv.DictReader(f):
                r=emit(normalize_structured(raw,source_type,source_tag))
                if r: yield r
    elif fmt=='jsonl':
        for line in path.read_text(encoding='utf-8',errors='replace').splitlines():
            if line.strip():
                r=emit(normalize_structured(json.loads(line),source_type,source_tag))
                if r: yield r
    elif fmt=='json':
        data=json.loads(path.read_text(encoding='utf-8',errors='replace')); recs=data if isinstance(data,list) else data.get('records',[]) if isinstance(data,dict) else []
        for raw in recs:
            r=emit(normalize_structured(raw,source_type,source_tag))
            if r: yield r
    else:
        text=path.read_text(encoding='utf-8',errors='replace').replace('\r\n','\n'); blocks=[b.strip() for b in re.split(r'\n\s*\n',text) if b.strip()] or [text]
        for b in blocks:
            r=emit(block_row(b,source_type,source_tag))
            if r: yield r
def write_csv(path,fields,rows):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('w',encoding='utf-8-sig',newline='') as f: w=csv.DictWriter(f,fieldnames=fields); w.writeheader(); w.writerows([{k:r.get(k,'') for k in fields} for r in rows])
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('input',type=Path); ap.add_argument('--format',choices=['auto','txt','csv','json','jsonl'],default='auto'); ap.add_argument('--accepted-out',type=Path); ap.add_argument('--rejected-out',type=Path); ap.add_argument('--report-out',type=Path); ap.add_argument('--min-score',type=float,default=5); ap.add_argument('--limit',type=int); ap.add_argument('--source-type',default='provider_file_import'); ap.add_argument('--source-tag',default='provider_text_import'); ap.add_argument('--out',type=Path); ap.add_argument('--write',action='store_true'); args=ap.parse_args()
    fmt=detect(args.input,args.format); accepted=[]; rejected=[]; ar=Counter(); rr=Counter(); seen=set(); total=0
    for row in read_rows(args.input,fmt,args.source_type,args.source_tag,args.limit):
        total+=1; sc,reasons,rej=score_row(row); row['score']=sc; row['match_reasons']='; '.join(reasons)
        key=(row.get('name','').lower(),row.get('address','').lower(),row.get('phone',''),row.get('sourceUrl',''))
        if key in seen: continue
        seen.add(key)
        if sc>=args.min_score and not rej.startswith('missing'):
            accepted.append(row); ar.update(reasons or ['accepted'])
        else:
            row['rejection_reason']=rej; rejected.append(row); rr.update([rej])
    if args.out and not args.accepted_out: args.accepted_out=args.out
    if args.accepted_out: write_csv(args.accepted_out,ACCEPTED_FIELDS,accepted)
    if args.rejected_out: write_csv(args.rejected_out,REJECTED_FIELDS,rejected)
    written=skipped=0
    if args.write and os.environ.get('SCRAPY_WRITE_TO_NEON') != '1':
        raise SystemExit('--write requires SCRAPY_WRITE_TO_NEON=1')
    if args.write:
        for row in accepted:
            res=write_provider(row); written += 1 if res.get('status')=='written' else 0; skipped += 0 if res.get('status')=='written' else 1
    report={'input file':str(args.input),'detected format':fmt,'sourceType':args.source_type,'sourceTag':args.source_tag,'total rows read':total,'accepted count':len(accepted),'rejected count':len(rejected),'written count':written,'skipped count':skipped,'top accepted reasons':ar.most_common(10),'top rejection reasons':rr.most_common(10)}
    if args.report_out: args.report_out.parent.mkdir(parents=True,exist_ok=True); args.report_out.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))
if __name__=='__main__': main()
