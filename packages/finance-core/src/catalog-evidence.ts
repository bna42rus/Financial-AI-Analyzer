import {extendedCatalogEvidence} from './extended-catalog.ts';
import {fullCatalogEvidence,supersededLegacy} from './full-catalog.ts';
import {merchantCatalog} from './merchant-catalog.ts';
import type {MerchantEntry} from './merchant-catalog.ts';
import {groceryEvidence} from './grocery-evidence.ts';
import {literalIndex,catalogFold,hasLiteral,literalNegated} from './catalog-lexical.ts';
export type CatalogInput={merchantText:string;description:string;bankCategory?:string;mcc?:string|null};
export type CatalogEvidence={status:'recognized';entry:MerchantEntry;literal:string;target:string|null;parentOnly:boolean;provisional:boolean;profileId?:string}|{status:'none'|'conflict'|'needs_context';reason:string};
const aliases=literalIndex(merchantCatalog.map(entry=>({value:entry,forms:entry.aliases})));
const serviceTargets:Readonly<Record<string,string>>={grocery:'grocery',cafe:'cafe',fitness:'fitness',public_transport:'public',carsharing:'carshare',powerbank:'powerbank',marketplace:'marketplace',cloud:'cloud',pharmacy:'pharmacy',fuel:'fuel',cinema:'events',books:'books',pets:'pet_goods',home:'home_goods',clothing:'clothes',electronics:'electronics',beauty:'salon',medical:'doctors',rail:'rail',air:'air',hotel:'hotel',education:'courses',cosmetics:'cosmetics',laboratory:'diagnostics',veterinary:'vet'};
/** Finite spelling data and typed guards; never execute restriction prose. */
export function recognizeCatalogEvidence(input:CatalogInput):CatalogEvidence{
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
