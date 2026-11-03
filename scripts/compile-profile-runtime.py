"""Compile finite spelling columns into typed, conservative merchant profiles.

Only explicit spelling fields are executable. Restriction prose is retained for
review, never evaluated as a rule. Category policy below is explicit; unknown
subjects and historical/reference/infrastructure rows have a terminal outcome.
"""
import argparse, hashlib, importlib.util, json, re, sys
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
ID=r'(?:FR\d{2}|F\d{2}|R\d{2}|PB\d{2}|H\d{3}|FS\d{3}|HOME\d{3}|FASH\d{3}|BEA\d{3}|NET\d{3}|TEL\d{3}|DIG\d{3}|MP\d{3}|ENT\d{3}|EDU\d{3}|TRV\d{3}|PET\d{3}|GFT\d{3}|FIN\d{3})'
def encode(x):return json.dumps(x,ensure_ascii=False,separators=(',',':'))
def clean(s):return re.sub(r'(?:\*\*|`)', '', s).strip()
def number(pid):return int(re.search(r'\d+$',pid)[0])
def policy(pid):
 n=number(pid);p=re.sub(r'\d+$','',pid);target=None;guard='subject';provisional=False;parent=False
 if p=='F':target='cafe';guard='food'
 elif p=='R':
  guard='transport'
  target='taxi' if n<=4 else 'public' if n<=21 else 'carshare' if n<=25 else 'micromobility' if n<=30 else 'fuel' if n<=48 else 'parking' if n<=56 else 'auto_service'
  provisional=n in [1,42,43,51]
  if n in [16,17,18,19,20,21,48,52,54,55,56,62,63,64]:guard='subject'
 elif p=='PB':target='powerbank';guard='powerbank'
 elif p=='H':
  guard='health';target='pharmacy' if n<=30 else 'doctors' if n<=51 else 'diagnostics' if n<=61 else 'dentistry' if n<=69 else 'optics' if n<=80 else 'medical_devices'
 elif p=='FS':
  guard='sport';target='fitness' if n<=62 else 'sport_goods'
  if n==49:target='child_sections'
  if 56<=n<=58:target='ent_other'
  if n==59:provisional=True
  if n in [79,81]:target='clothes'
  if n==83:target='sport_nutrition'
 elif p=='HOME':
  guard='home';target='home_repair' if n<=18 else 'home_goods' if n<=43 else 'utilities' if n<=51 else 'household_service' if n<=53 or n==57 else None
  if n>=54:guard='subject'
  if n==57:provisional=True
 elif p=='FASH':
  guard='fashion';target='clothes' if n<=36 or 56<=n<=65 else 'shoes' if n<=54 else 'child_goods' if n==55 or 74<=n<=82 else 'accessories' if 66<=n<=73 or n>=91 else None
  if 83<=n<=88:guard='subject'
 elif p=='BEA':
  guard='beauty';target='cosmetics' if n<=33 else 'salon' if n<=50 else 'care_other' if n<=54 else None
  if 14<=n<=33 or n>=55:guard='subject'
  if n in [23,27]:target=None
  if n==53:provisional=True
 elif p in ['NET','TEL']:
  guard='telecom';target='mobile' if n<=16 and p=='NET' else 'internet' if p=='NET' and 18<=n<=42 else None
  if p=='NET' and n in [17,35]:target='telecom_root';provisional=True;parent=True
  if p=='NET' and n>=43:guard='subject'
  if p=='TEL' and 40<=n<=44:target='video'
 elif p=='DIG':
  guard='digital';target='subscription_other' if n<=8 else 'video' if n<=24 else 'books' if n<=29 else None if n<=34 else 'cloud' if n in [35,36,37,38,39,41,44] else 'software' if n<=56 else 'ai' if n<=64 else 'cloud' if n<=74 else 'software' if n<=77 else 'software' if n<=89 else 'games' if n<=94 else 'vpn'
  if n in [33,54,57,58,59,62,63,64,78,79,80,81,82,83,84,85,86,87,88,89,90,91]:guard='subject'
 elif p=='MP':
  guard='retail';target='marketplace' if n<=11 and n not in [8] or n==14 else 'electronics' if 15<=n<=38 else 'home_repair' if 39<=n<=46 else 'home_goods' if n in [47,48,50,51,52] else 'child_goods' if 53<=n<=56 else 'books' if 57<=n<=59 else 'hobby' if n in [60,70,71] else 'games' if n==61 else 'grocery' if n in [66,67] else 'sport_goods' if n in [68,69] else None
  if n in [6,8,9,10,11,12,13,49,62,63,64,65]:guard='subject'
 elif p=='ENT':
  guard='entertainment';target='events' if n<=52 or 63<=n<=65 else 'ent_other' if n<=69 else 'games' if n<=73 or 83<=n<=85 else 'books' if n<=81 else 'hobby'
  if n in [8,33,54,56,57]:guard='subject'
 elif p=='EDU':
  guard='education';target='courses' if n<=14 or 27<=n<=34 else 'child_education' if n<=26 else None if n<=46 else 'child_sections' if n<=54 else 'child_goods' if n<=68 else None if n<=78 else 'child_other'
  if n==10 or 35<=n<=46 or 69<=n<=78:guard='subject'
 elif p=='TRV':
  guard='travel';target='air' if n<=15 else 'rail' if n<=18 else 'public' if n==19 else 'intercity' if n<=24 else 'tours' if n<=29 else None if n<=38 else 'hotel' if n<=45 or 64<=n<=77 else 'tours' if n<=63 else None if n<=84 else 'logistics'
  if 30<=n<=38 or 78<=n<=84:guard='subject'
 elif p=='PET':
  guard='pet';target='pet_goods' if n<=29 or n in [53,67,68] else 'vet' if n<=47 else 'pet_care' if n<=62 else None
  if 18<=n<=29 or n>=63:guard='subject'
 elif p=='GFT':
  guard='gift';target='gifts' if 2<=n<=7 else 'charity' if 21<=n<=49 else None
  if not target:guard='subject'
 elif p=='FIN':guard='financial'
 elif p=='FR':guard='subject'
 return dict(target=target,guard=guard,provisional=provisional,parentOnly=parent)
# These exact profile IDs need an independent merchant/service identity signal,
# not an ordinary purchase or an arbitrary word in the description.
CONTEXT='F15 F17 F38 F39 F47 F49 R02 R16 R17 R18 R19 R20 R21 R30 R34 R40 R41 R44 R48 R52 R54 R55 R56 R62 R63 R64 R65 R66 PB02 PB04 PB05 PB06 H004 H008 H010 H012 H014 H019 H020 H028 H033 H034 H037 H039 H040 H041 H044 H055 H056 H063 H065 H075 H076 H078 H079 H080 H083 H084 FS006 FS007 FS010 FS013 FS030 FS034 FS036 FS037 FS043 FS045 FS046 FS048 FS053 FS055 FS057 FS061 FS064 FS067 FS068 FS081 FS082 HOME003 HOME010 HOME012 HOME017 HOME023 HOME025 HOME029 HOME031 HOME032 HOME041 HOME042 HOME043 HOME051 HOME053 HOME057 FASH002 FASH005 FASH010 FASH013 FASH030 FASH031 FASH032 FASH040 FASH045 FASH073 FASH076 FASH081 FASH083 FASH084 FASH085 FASH086 FASH087 FASH088 FASH090 FASH091 FASH092 BEA001 BEA004 BEA005 BEA013 BEA023 BEA024 BEA030 BEA033 BEA034 BEA038 BEA040 BEA043 BEA049 BEA050 BEA051 BEA055 BEA056 NET013 NET014 NET017 NET030 NET039 DIG004 DIG010 DIG011 DIG012 DIG013 DIG019 DIG030 DIG033 DIG054 DIG057 DIG058 DIG059 DIG064 DIG078 DIG080 DIG090 MP001 MP006 MP008 MP010 MP013 MP016 MP023 MP028 MP035 MP036 MP038 MP049 MP050 MP056 MP062 MP063 MP065 MP066 ENT001 ENT004 ENT008 ENT016 ENT019 ENT025 ENT033 ENT039 ENT048 ENT054 ENT056 ENT057 ENT066 ENT070 ENT078 ENT082 ENT087 EDU010 EDU013 EDU020 EDU035 EDU036 EDU037 EDU038 EDU039 EDU040 EDU041 EDU043 EDU044 EDU045 EDU046 EDU047 EDU051 EDU067 EDU068 EDU069 EDU070 EDU073 EDU074 EDU075 EDU076 EDU077 EDU078 TRV005 TRV008 TRV010 TRV011 TRV015 TRV016 TRV017 TRV018 TRV025 TRV030 TRV033 TRV039 TRV040 TRV044 TRV048 TRV051 TRV052 TRV054 TRV055 TRV057 TRV060 TRV061 TRV062 TRV063 TRV066 TRV078 PET001 PET009 PET010 PET011 PET015 PET024 PET030 PET031 PET032 PET034 PET035 PET038 PET044 PET048 PET051 PET063 PET064 PET066 GFT001 GFT003 GFT004 GFT005 GFT006 GFT007 GFT021 GFT023 GFT025 GFT026 GFT027 GFT028 GFT030 GFT034 GFT039 GFT043 GFT050 GFT056 GFT057 GFT058'.split()
# Cross-section links are explicit, reviewed identities, not alias similarity.
BRIDGES={'R28':'R01','TRV019':'R11','MP039':'HOME001','MP040':'HOME003','MP041':'HOME004','MP042':'HOME005','MP043':'HOME006','MP044':'HOME007','MP045':'HOME008','MP046':'HOME011','MP047':'HOME019','MP048':'HOME028','MP050':'HOME043','MP051':'HOME042','MP052':'HOME037','MP062':'FASH085','MP064':'FASH084','MP014':'FASH086','MP068':'FS063','MP069':'FS064','EDU055':'MP053','EDU056':'MP054','EDU057':'MP055','EDU058':'MP056','EDU064':'FASH076','EDU065':'FASH055','EDU066':'FASH074','EDU071':'MP057','EDU072':'MP058','PET069':'MP001','PET070':'MP002','GFT059':'MP001','GFT060':'MP002','GFT061':'MP003','HOME054':'FR01','HOME055':'FR02','HOME056':'FR03','PET071':'FR02','ENT061':'FS056','ENT062':'FS057','ENT074':'MP057','ENT075':'MP058','ENT076':'MP059','ENT082':'MP060','ENT083':'MP061','ENT090':'MP070','ENT091':'MP071','OFF001':'EDU069'}
LEGACY={'F01':'Кофемания','F02':'Шоколадница','F03':'Кофикс','F05':'Даблби','F14':'Му-Му','F16':'Братья Караваевы','F22':'Бургер Кинг','F23':'Теремок','F24':'Крошка Картошка','F25':'Додо Пицца','F29':'Якитория','F50':'Маковка','F51':'Буханка','FS001':'Ворлд Класс','FS002':'X-Fit','FS003':'DDX Fitness','FS004':'Спирит Фитнес','FS063':'Спортмастер','R01':'Яндекс Go','R05':'Мостранспорт','R07':'Мосгортранс','R22':'Делимобиль','R23':'Яндекс Драйв','R24':'Ситидрайв','R25':'БелкаКар','PB01':'Бери заряд','PB02':'Энерго','H001':'Горздрав','H002':'Столички','H003':'Ригла','H004':'Аптека 36,6','H053':'Гемотест','HOME001':'Лемана ПРО','HOME019':'Hoff','FASH086':'Ламода','BEA001':'Золотое яблоко','BEA005':'Подружка','BEA007':'М.Косметик','MP001':'Ozon','MP002':'Wildberries','MP003':'Яндекс Маркет','MP015':'DNS','MP016':'М.Видео','MP057':'Читай-город','PET001':'Четыре лапы','PET002':'Бетховен','DIG065':'TimeWeb','NET001':'МТС','NET002':'Мегафон','NET003':'Билайн','NET004':'Т2','NET005':'Йота','NET018':'Ростелеком'}
def build():
 spec=importlib.util.spec_from_file_location('catalog_build',ROOT/'scripts/compile-merchant-catalog.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);ir=m.compile_catalog();profiles={};origins={}
 def row(pid,name,forms,condition,doc,line,source='',status='SRC'):
  if not forms:return
  forms=list(dict.fromkeys(clean(f) for f in forms if clean(f)))
  if pid in profiles:
   existing=profiles[pid];existing['forms']=list(dict.fromkeys(existing['forms']+forms));return
  r=dict(id=pid,name=clean(name),forms=forms,condition=clean(condition),sourceDocument=doc,sourceLine=line,source=source,status=status,**policy(pid));r['requiresContext']=pid in CONTEXT;r['group']=BRIDGES.get(pid,pid);r['legacyName']=LEGACY.get(pid);profiles[pid]=r
 # Master sections have per-profile headings and specifically labelled spellings.
 for d in ir['documents']:
  for b in d['blocks']:
   if b['kind']!='context' or not b['heading_path']:continue
   h=re.fullmatch('('+ID+r')\.\s+(.+)',b['heading_path'][-1])
   if not h:continue
   forms=[]
   for line in b['text'].splitlines():
    if line.startswith('- ') and ':' in line and re.search('форм|вариант|кандидат|Кириллица',line.split(':')[0],re.I) and not re.search('число|огранич',line.split(':')[0],re.I):forms+=re.findall(r'`([^`]+)`',line)
   condition=' '.join(line.split(':',1)[1] for line in b['text'].splitlines() if re.match(r'- (?:Индивидуальное ограничение|Ограничение):',line))
   row(h[1],h[2],forms,condition,d['path'],b['from_line'])
 # The FR paragraph mixes positive and negative examples. Keep only the
 # independently enumerated, approved positive spellings; never harvest prose.
 fr={
  'FR01':['YouDo','You Do','Юду'],'FR02':['Профи.ру','Profi.ru','Профи ру'],
  'FR03':['Яндекс Услуги','Яндекс.Услуги','Яндекс Исполнители','Yandex Uslugi'],
  'FR04':['Kwork','Кворк'],'FR05':['FL.ru','ФЛ.ру'],
  'FR06':['Workzilla','Work-zilla','Воркзилла'],'FR07':['Freelance.ru','Фриланс.ру'],
  'FR08':['Weblancer','Weblancer.net','Веблансер'],'FR09':['Freelancehunt','Freelancehunt.com'],
  'FR10':['Авито Услуги','Avito Uslugi']}
 master=ir['documents'][0];t=next(b for b in master['blocks'] if b['kind']=='table' and b['table']==1)
 for r in t['rows']:
  c=r['cells'];row(c[0],c[1].split(' — ')[0],fr[c[0]],c[2],master['path'],r.get('from_line',t['from_line']),c[3])
 # Standalone tables: only explicit forms column; no aliases from guard prose.
 for d in ir['documents']:
  for b in d['blocks']:
   if b['kind']!='table' or len(b['header'])<2 or not re.search('форм|кандидат',b['header'][1],re.I):continue
   for r in b['rows']:
    c=r['cells'];h=re.match('^('+ID+r')\s+(.+)',clean(c[0]))
    if h:row(h[1],re.sub(r'\s+\((?:SRC|IDX|INT|REF|PEND|HIST)\)$','',h[2]),c[1].split(';'),c[2] if len(c)>2 else '',d['path'],r.get('from_line',b['from_line']))
 # Source/status list metadata never supplies matching aliases.
 for d in ir['documents']:
  for b in d['blocks']:
   if b['kind']!='table':continue
   for r in b['rows']:
    c=r['cells'];pid=clean(c[0]);p=profiles.get(pid)
    if not p or len(c)<3:continue
    if any('источник' in h.lower() for h in b['header']):
     reference=re.search(r'(?:Ссылка|Связь):\s*('+ID+r')(?![\d-])',' '.join(c[2:]))
     if reference and reference[1]!=pid:p['group']=reference[1]
     source=' '.join(v for j,v in enumerate(c) if j<len(b['header']) and 'источник' in b['header'][j].lower());p['source']=source
     status=next((v for v in ['PEND','HIST','REF','INT','IDX','SRC'] if re.search(r'\b'+v+r'\b',' '.join(c[2:]))),p['status']);p['status']=status
 # Later owner source dispositions close earlier PEND while retaining guards.
 for r in ir['source_dispositions']['records']:
  p=profiles.get(r['id'])
  if p:
   p['disposition']=r['disposition'];p['source']=r.get('source_url') or p['source']
 for p in profiles.values():
  p.setdefault('disposition','DOCUMENTED')
  blocked=p['status'] in ['PEND','HIST','REF'] or p['disposition'] in ['GENERIC_ACTIVITY_ONLY','HISTORICAL_CONTEXT_ONLY','REF_PROFILE','EXCLUDED_FROM_ACTIVE_V1'] or p['disposition'].startswith('BLOCKED')
  # Explicit confirmed dispositions replace source PEND, not HIST/REF or policy.
  if p['disposition'] in ['PROFILE_CONFIRMED','PROFILE_CONTEXT_ONLY'] and p['status']=='PEND':blocked=False
  p['active']=not blocked and p['guard']!='financial' and not p['id'].startswith('TEL')
  p['outcome']='ACTIVE_TYPED_PROFILE' if p['active'] and p['target'] else 'ACTUAL_SUBJECT_REQUIRED' if p['active'] else 'INACTIVE_SOURCE_OR_REFERENCE'
 # Keep role-specific references in inventory; they do not become second shops.
 for p in profiles.values():
  if p['group']!=p['id'] and p['group'] in profiles:
   primary=profiles[p['group']]
   if p['target']==primary['target'] and p['active'] and primary['active']:
    primary['forms']=list(dict.fromkeys(primary['forms']+p['forms']));p['active']=False;p['outcome']='EXPLICIT_CROSS_SECTION_REFERENCE'
   p['legacyName']=primary['legacyName']
 rows=sorted(profiles.values(),key=lambda p:p['id']);assert len(rows)>1000;assert all(p['forms'] for p in rows)
 body='// Generated only from explicit finite spelling fields and typed policies.\n'
 body+="export type FullCatalogProfile={id:string;name:string;forms:readonly string[];sourceDocument:string;sourceLine:number;source:string;status:string;target:string|null;guard:string;provisional:boolean;parentOnly:boolean;requiresContext:boolean;group:string;legacyName:string|null;disposition:string;active:boolean;outcome:string};\n"
 runtime=[{k:v for k,v in p.items() if k!='condition'} for p in rows]
 body+='export const fullCatalogProfiles:readonly FullCatalogProfile[]='+encode(runtime)+';\n'
 body+="export const fullCatalogDataSha256='"+hashlib.sha256(encode(rows).encode()).hexdigest()+"';\n"
 return body.encode(),rows
if __name__=='__main__':
 a=argparse.ArgumentParser(description=__doc__);a.add_argument('--check',action='store_true');args=a.parse_args();data,rows=build();p=ROOT/'packages/finance-core/src/catalog/generated/profiles-v1.ts'
 if args.check:
  if not p.exists() or p.read_bytes()!=data:raise SystemExit('PROFILE_RUNTIME_DRIFT')
 else:p.write_bytes(data)
 print(encode({'status':'PASS_FINITE_PROFILE_DATA','profiles':len(rows),'forms':sum(len(p['forms']) for p in rows),'active':sum(p['active'] for p in rows),'sha256':hashlib.sha256(data).hexdigest(),'paidCalls':0,'semanticAccuracyClaim':False}))
