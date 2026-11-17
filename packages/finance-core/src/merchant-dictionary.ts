import {defaultMerchantDictionary} from './catalog/merchant-dictionary-data.ts';
import {merchantLiteralIndex,catalogFold} from './catalog-lexical.ts';
import {categoryTargets} from './catalog/generated/activity-v1.ts';
export type DictionaryEntry={id:string;name:string;forms:readonly string[];target:string;confidence:number;tokens?:readonly (readonly string[])[]};
export type MerchantDictionary={schema:'cashneuro-merchant-dictionary/1';revision:string;entries:readonly DictionaryEntry[]};
const targets=new Set([...categoryTargets.map(t=>t.key),'scooter','subscription_other','telecom_root','telecom_other','education']);
let current:MerchantDictionary=defaultMerchantDictionary;
const words=(text:string)=>catalogFold(text).replace(/[&+]/gu,' ').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/gu,' ').trim();
let index=merchantLiteralIndex(current.entries.map(e=>({value:e,forms:e.forms.map(words)})));
export function validateMerchantDictionary(value:unknown):MerchantDictionary{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_MERCHANT_DICTIONARY');
 const d=value as MerchantDictionary;
 if(Object.keys(d).sort().join(',')!=='entries,revision,schema'||d.schema!=='cashneuro-merchant-dictionary/1'||typeof d.revision!=='string'||!/^[-.a-zA-Z0-9]{1,80}$/u.test(d.revision)||!Array.isArray(d.entries)||d.entries.length>3000)throw Error('INVALID_MERCHANT_DICTIONARY');
 const ids=new Set<string>(),aliases=new Map<string,string>();
 for(const e of d.entries){
  if(!e||Object.keys(e).some(k=>!['id','name','forms','target','confidence','tokens'].includes(k))||typeof e.id!=='string'||!/^[-a-zA-Z0-9]{1,80}$/u.test(e.id)||ids.has(e.id)||typeof e.name!=='string'||!e.name.trim()||e.name.length>160||/[\p{Cc}\p{Cf}]/u.test(e.name)||!targets.has(e.target)||![80,96].includes(e.confidence)||!Array.isArray(e.forms)||!e.forms.length||e.forms.length>300)throw Error('INVALID_MERCHANT_DICTIONARY');
  ids.add(e.id);
  for(const form of e.forms){if(typeof form!=='string'||form.length>160||!words(form)||/[\p{Cc}\p{Cf}]/u.test(form))throw Error('INVALID_MERCHANT_DICTIONARY');const key=words(form),prior=aliases.get(key);if(prior&&prior!==e.id)throw Error('AMBIGUOUS_MERCHANT_DICTIONARY');aliases.set(key,e.id);}
  if(e.tokens!==undefined&&(!Array.isArray(e.tokens)||e.tokens.length>30||e.tokens.some((set:readonly string[])=>!Array.isArray(set)||set.length<2||set.length>8||set.some(t=>typeof t!=='string'||!words(t)||words(t).includes(' ')))))throw Error('INVALID_MERCHANT_DICTIONARY');
 }
 return structuredClone(d);
}
export function setMerchantDictionary(value:unknown){const next=validateMerchantDictionary(value),nextIndex=merchantLiteralIndex(next.entries.map(e=>({value:e,forms:e.forms.map(words)})));current=next;index=nextIndex;}
export const merchantDictionaryRevision=()=>current.revision;
export function dictionaryMerchant(merchant:string,description=''):{entry:DictionaryEntry;target:string;confidence:number}|null{
 if(!merchant.trim()||/\p{Cf}/u.test(merchant))return null;
 const text=words(merchant),tokens=new Set([...text.matchAll(/[\p{L}]+|[\p{N}]+/gu)].filter(m=>!/(?:^| )не $|(?:^| )not $/u.test(text.slice(0,m.index))).map(m=>m[0]));
 const found=new Map(index(text).filter(h=>!/(?:^| )не $|(?:^| )not $/u.test(text.slice(0,h.from))).map(h=>[h.value.id,h.value]));
 for(const e of current.entries)if(e.tokens?.some(set=>set.every(t=>tokens.has(words(t)))))found.set(e.id,e);
 // A specific paid Yandex/Telegram service wins over its containing brand.
 if(found.has('owner-yandex-scooter'))found.delete('owner-samokat');
 if(found.has('owner-yandex-charge')||found.has('owner-yandex-scooter')||found.has('owner-yandex-cloud')||found.has('owner-yandex-drive'))found.delete('owner-yandex-go');
 if(found.has('owner-telegram-premium'))found.delete('owner-telegram');
 if(found.size!==1)return null;
 const entry=[...found.values()][0]!;
 const body=catalogFold(merchant+' '+description);
 if(entry.target==='grocery'&&/(?:кафе|кофейня|ресторан|отель|hotel|restaurant|cafe|kafe|pharmacy|аптека)(?=$|[^\p{L}])/iu.test(body))return null;
 if(entry.id==='owner-megafon'){
  if(/покупка (?:телефона|смартфона|роутера)|оборудование/iu.test(body))return null;
  if(/домашн[а-яё]* интернет|доступ в интернет/iu.test(body))return {entry,target:'internet',confidence:96};
  return {entry,target:'mobile',confidence:/мобильн[а-яё]* (?:связь|интернет|тариф)/iu.test(body)?96:entry.confidence};
 }
 if(entry.id==='owner-yandex-go'){
  if(/пауэрбанк|powerbank|аренда зарядки/iu.test(body))return {entry,target:'powerbank',confidence:96};
  if(/(?:^|[^\p{L}])заряд(?=$|[^\p{L}])|charge/iu.test(body))return {entry,target:'powerbank',confidence:80};
  if(/доставк|delivery|dostavka/iu.test(body))return {entry,target:'logistics',confidence:96};
  if(/такси|taxi/iu.test(body))return {entry,target:'taxi',confidence:96};
 }
 let target=entry.target;

 return {entry,target,confidence:entry.confidence};
}
