import {extendedCatalogEvidence} from './extended-catalog.ts';
import {fullCatalogEvidence,fullCatalogHits,supersededLegacy} from './full-catalog.ts';
import {merchantCatalog} from './merchant-catalog.ts';
import type {MerchantEntry} from './merchant-catalog.ts';
import {groceryEvidence} from './grocery-evidence.ts';
import {dictionaryMerchant} from './merchant-dictionary.ts';
import {merchantLiteralIndex,literalIndex,catalogFold,hasLiteral,literalNegated} from './catalog-lexical.ts';
export type CatalogInput={merchantText:string;description:string;bankCategory?:string;mcc?:string|null};
export type CatalogEvidence={status:'recognized';entry:MerchantEntry;literal:string;target:string|null;parentOnly:boolean;provisional:boolean;profileId?:string}|{status:'none'|'conflict'|'needs_context';reason:string};
const aliases=merchantLiteralIndex(merchantCatalog.map(entry=>({value:entry,forms:entry.aliases})));
const serviceTargets:Readonly<Record<string,string>>={grocery:'grocery',cafe:'cafe',fitness:'fitness',public_transport:'public',carsharing:'carshare',powerbank:'powerbank',marketplace:'marketplace',cloud:'cloud',pharmacy:'pharmacy',fuel:'fuel',cinema:'events',books:'books',pets:'pet_goods',home:'home_goods',clothing:'clothes',electronics:'electronics',beauty:'salon',medical:'doctors',rail:'rail',air:'air',hotel:'hotel',education:'courses',cosmetics:'cosmetics',laboratory:'diagnostics',veterinary:'vet'};
/** Finite spelling data and typed guards; never execute restriction prose. */
export function recognizeCatalogEvidence(input:CatalogInput):CatalogEvidence{
 const dictionary=dictionaryMerchant(input.merchantText,input.description);
 if(dictionary&&dictionary.entry.id.startsWith('owner-yandex-')){
  const equivalent:Record<string,string[]>={'owner-yandex-drive':['R23'],'owner-yandex-cloud':['DIG072'],'owner-yandex-go':['R01'],'owner-yandex-scooter':['R28'],'owner-yandex-charge':[]};
  const other=fullCatalogHits(input.merchantText).filter(h=>h.value.target!==null&&!literalNegated(input.merchantText,h)&&/яндекс|yandex/iu.test(h.value.name)&&!(equivalent[dictionary.entry.id]??[]).includes(h.value.id)&&!(h.value.id==='R28'&&!/самокат|scooter|велосипед|bike/iu.test(h.form))&&!(h.value.id==='R01'&&dictionary.entry.id!=='owner-yandex-go'));
  if(other.length)return {status:'conflict',reason:'MULTIPLE_YANDEX_SERVICES'};
 }
 if(dictionary)return {status:'recognized',entry:{name:dictionary.entry.name,aliases:[...dictionary.entry.forms],service:'unknown',source:'owner-approved:merchant-dictionary'},literal:dictionary.entry.name,target:dictionary.target,parentOnly:false,provisional:dictionary.confidence<90,profileId:dictionary.entry.id};
 // Search projection only: bank/terminal wrappers and branch identifiers
 // cannot change the immutable permitted source or keyed identity.
 input={...input,merchantText:input.merchantText.replace(/^(?:SBER|СБЕР)[ *._-]*\d{4}[ *._-]*/iu,'').replace(/(?<=[\p{L}])[_-]\d+[a-z]?(?=$|[\s,.*_-])/giu,' ').replace(/[_*]+/gu,' ')};
 const text=input.merchantText.trim();if(!text)return {status:'none',reason:'NO_MERCHANT_FIELD'};
 const all=aliases(text),found=all.filter(h=>!literalNegated(text,h));
 if(all.length&&!found.length)return {status:'needs_context',reason:'NEGATED_MERCHANT_MENTION'};
 const entries=[...new Map(found.map(h=>[h.value.name,h.value])).values()];
 const specific=entries.filter(e=>!entries.some(other=>other.parentBrand===e.name));
 if(specific.length>1)return {status:'conflict',reason:'MULTIPLE_MERCHANT_PROFILES'};
 const extended=extendedCatalogEvidence(input),full=fullCatalogEvidence(input);
 const entry=specific[0];
 if(full.status==='recognized'){
  if(extended.status==='recognized')return {status:'conflict',reason:'FULL_AND_EXTENDED_PROFILE_CONFLICT'};
  if(!entry)return full;
  if(entry.name===full.entry.name)return {...full,entry:{...full.entry,aliases:[...new Set([...full.entry.aliases,...entry.aliases])]}};
  if((supersededLegacy[full.profileId??'']??[]).includes(entry.name))return full;
  return {status:'conflict',reason:'LEGACY_AND_FULL_PROFILE_CONFLICT'};
 }
 if(full.status==='conflict')return full;
 if(!entry)return extended.status==='none'?full:extended;
 if(extended.status==='conflict'||extended.status==='needs_context')return extended;
 if(extended.status==='recognized')return {status:'conflict',reason:'LEGACY_AND_EXTENDED_PROFILE_CONFLICT'};
 const literal=found.find(h=>h.value===entry)!.form;
 if(entry.groceryStore&&!groceryEvidence(entry,text,input.description,input,false))return {status:'conflict',reason:'GROCERY_PROFILE_CONTEXT_CONFLICT'};
 if(entry.name==='Энерго'&&!hasLiteral(text+' '+input.description,['пауэрбанк','powerbank','аренда зарядки','прокат зарядки']))return {status:'needs_context',reason:'ENERGO_SERVICE_NOT_ESTABLISHED'};
 let target=serviceTargets[entry.service]??null,parentOnly=entry.service==='clothing',provisional=false;
 if(entry.service==='telecom'){target='telecom_root';parentOnly=true;}
 if(entry.name==='Спортмастер')target='sport_goods';
 if(entry.name==='Лемана ПРО')target='home_repair';
 if(entry.name==='Яндекс Go'){target='taxi';provisional=true;}
 if(entry.name==='Сервисы Яндекса')target=null;
 return {status:'recognized',entry,literal,target,parentOnly,provisional};
}
/** A single display identity per recognized profile, independent of source alphabet. */
export function canonicalCatalogName(name:string,raw=''):string{
 if(name==='Ozon'&&/ozon[ ._-]*fresh|озон[ ._-]*фреш/iu.test(raw))return 'Ozon Fresh';
 const preferred:Record<string,string>={'Ворлд Класс':'World Class','Спирит Фитнес':'Spirit Fitness','Т2':'t2','585*ЗОЛОТОЙ':'585 Золотой','Икс Фит':'X-Fit','Timeweb':'TimeWeb','Timeweb Cloud':'TimeWeb','Энерго':'Energo','БелкаКар':'BelkaCar'};
 return preferred[name]??name.split(/\s+[\/]\s+|\s+—\s+/u)[0]!.trim();
}
/** Additional explicitly agreed broad service profiles. They do not identify a
 * company/payee or rename a merchant, and unknown Yandex is not Go. */
export function serviceProfileDefault(text:string):{target:string;provisional:boolean;profileId?:string}|null{
 const positive=(forms:readonly string[])=>literalIndex([{value:true,forms}])(text).some(h=>!literalNegated(text,h));
 if(positive(['яндекс заправки','yandex zapravki']))return {target:'fuel',provisional:true};
 if(positive(['парковки россии','parkovki rossii']))return {target:'parking',provisional:true};
 if(positive(['ozon fresh','ozon.fresh','озон фреш','озон fresh']))return {target:'grocery',provisional:false};
 // Full service, not the corporate Yandex token. Subject conflicts are handled above it.
 if(positive(['яндекс лавка','yandex lavka']))return {target:'grocery',provisional:false};
 return null;
}
export const catalogProfileKey=(e:CatalogEvidence)=>e.status==='recognized'?'legacy-catalog:'+catalogFold(e.entry.name):null;
