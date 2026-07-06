import csv, json, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class ImportProviderTextTests(unittest.TestCase):
    def run_import(self, content, suffix='.txt', source_type='google_local_jsonl_import'):
        td=tempfile.TemporaryDirectory(); d=Path(td.name); inp=d/('input'+suffix); inp.write_text(content,encoding='utf-8')
        acc,rej,rep=d/'accepted.csv',d/'rejected.csv',d/'report.json'
        cmd=[sys.executable,str(ROOT/'scripts/import_provider_text.py'),str(inp),'--source-type',source_type,'--source-tag','test','--accepted-out',str(acc),'--rejected-out',str(rej),'--report-out',str(rep)]
        subprocess.run(cmd,cwd=ROOT,check=True,env={'SCRAPY_WRITE_TO_NEON':'0'})
        return td,list(csv.DictReader(acc.open(encoding='utf-8-sig'))),list(csv.DictReader(rej.open(encoding='utf-8-sig'))),json.loads(rep.read_text())
    def test_jsonl_txt_accept_reject_and_mappings(self):
        rows=[
            {'name':'Mobile Nursing and Rehabilitation, LLC','category':['Nursing home','Rehabilitation center'],'address':'Mobile Nursing and Rehabilitation, LLC, 7020 Bruns Dr, Mobile, AL 36695','phone':'(251) 555-1212','latitude':30.6,'longitude':-88.2,'url':'https://www.google.com/maps/place/x','state':'Open'},
            {'name':'Purple Peanut','category':['Boutique'],'address':'1 Main St, Mobile, AL 36602','phone':'2515550000'},
            {'name':'Pizza Hut','category':['Pizza restaurant'],'address':'2 Main St, Mobile, AL 36602'},
            {'name':'Piney Grove Freewill Baptist','category':['Church'],'address':'3 Main St, Mobile, AL 36602'},
            {'name':'Linx Plaza Apartments','category':['Apartment building'],'address':'4 Main St, Mobile, AL 36602'},
        ]
        td,acc,rej,rep=self.run_import('\n'.join(json.dumps(r) for r in rows),'.txt')
        try:
            self.assertEqual(rep['detected format'],'jsonl')
            self.assertEqual(len(acc),1); self.assertEqual(len(rej),4)
            r=acc[0]; self.assertEqual(r['lat'],'30.6'); self.assertEqual(r['lng'],'-88.2')
            self.assertEqual(r['sourceUrl'],'https://www.google.com/maps/place/x'); self.assertEqual(r['website'],'')
            self.assertEqual(r['state'],'AL'); self.assertEqual(r['postalCode'],'36695'); self.assertEqual(r['city'],'Mobile')
            names={x['name'] for x in rej}; self.assertIn('Purple Peanut',names); self.assertIn('Pizza Hut',names); self.assertIn('Piney Grove Freewill Baptist',names); self.assertIn('Linx Plaza Apartments',names)
        finally: td.cleanup()
    def test_csv_aliases_and_outputs(self):
        content='provider_name,provider_type,specialty,category,address,phone\nTest Medical,Medical clinic,Primary care,Clinic,"10 Main St, Mobile, AL 36602",2515551212\n'
        td,acc,rej,rep=self.run_import(content,'.csv','provider_file_import')
        try:
            self.assertEqual(acc[0]['name'],'Test Medical')
            self.assertIn('Medical clinic',acc[0]['services'])
            self.assertTrue(rep['accepted count']>=1)
        finally: td.cleanup()
if __name__=='__main__': unittest.main()
