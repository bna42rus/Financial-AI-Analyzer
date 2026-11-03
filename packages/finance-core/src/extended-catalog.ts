import {extendedProfiles,extendedCatalogSha256} from './catalog/generated/name-v1.ts';
import {literalIndex,hasLiteral,literalNegated} from './catalog-lexical.ts';
import type {MerchantEntry} from './merchant-catalog.ts';
import type {CatalogInput} from './catalog-evidence.ts';
export {extendedCatalogSha256};
const index=literalIndex(extendedProfiles.map(p=>({value:p,forms:p.forms})));
export const extendedCatalogHits=(text:string)=>index(text);
export function extendedCatalogEvidence(i:CatalogInput):{status:'recognized';entry:MerchantEntry;literal:string;target:string|null;parentOnly:boolean;provisional:boolean;profileId:string}|{status:'none'|'needs_context'|'conflict';reason:string}{
 const hits=index(i.merchantText).filter(h=>h.value.active&&!literalNegated(i.merchantText,h));
 const found=[...new Map(hits.map(h=>[h.value.id,h.value])).values()].filter(p=>!(p.id==='LOG001'&&hits.some(h=>h.value.id==='LOG002')));
 if(!found.length)return {status:'none',reason:'NO_EXTENDED_PROFILE'};
 if(found.length>1)return {status:'conflict',reason:'MULTIPLE_EXTENDED_PROFILES'};
 const p=found[0]!,text=i.merchantText+' '+i.description,bank=i.bankCategory??'',mcc=i.mcc??'';
 const has=(forms:readonly string[])=>hasLiteral(text,forms),hint=(forms:readonly string[],codes:readonly string[])=>hasLiteral(bank,forms)||codes.includes(mcc);
 const local:Readonly<Record<string,readonly string[]>>={SVC007:['нижний новгород','lavanderia-nn.ru'],SVC008:['санкт-петербург','санкт петербург','rematelier.ru'],SVC009:['atelier-online.ru'],SVC010:['санкт-петербург','санкт петербург','masterminutka.ru'],SVC012:['люберцы','mistermaster1.ru'],OFF006:['copy.spb.ru']};
 if(local[p.id]&&!has(local[p.id]!))return {status:'needs_context',reason:'LOCAL_OPERATOR_NOT_ESTABLISHED'};
 const work=has(['для работы','для бизнеса','рабочая цель','office rental','коворкинг','сервисный офис','рабочее пространство','переговорная']);
 // Bare organization names never prove an unrelated payment, goods basket,
 // statutory levy, deposit, balance or institutional recipient.
 if(has(['наложенный платёж','наложенный платеж','стоимость товара','пополнение баланса','залог','cash on delivery','франшиза','покупка оборудования','налоговый платеж']))return {status:'needs_context',reason:'EXTENDED_ACTUAL_SUBJECT_REQUIRED'};
 const ordinaryPayment=/^(?:покупка|оплата|purchase|card payment)(?=$|[^\p{L}\p{N}])/iu.test(i.description);
 const clearDefaults=new Set(['LOG003','LOG008','LOG011','LOG015','LOG016','LOG017','LOG018','LOG019','LOG020','SVC006','SVC011','SVC016','OFF014','OFF015','OFF016','OFF017']);
 let proven=false;
 switch(p.guard){
  case 'logistics':proven=has(['курьерская услуга','услуги доставки','пересылка','перевозка груза','отправка посылки','доставка посылки','отдельная доставка','courier service','parcel delivery','freight'])||hint(['курьерские услуги','грузоперевозки','почтовые услуги'],['4214','4215','4225','9402']);break;
  case 'household':proven=has(['химчистка','химчистки','прачечная','стирка','ремонт обуви','ремонт техники','ремонт телефона','ремонт одежды','ремонт часов','изготовление ключей','dryclean','dry cleaning','cleaners','repair service'])||hint(['бытовые услуги','ремонт техники','химчистка'],['7210','7211','7216','7217','7251','7629','7699']);break;
  case 'professional':proven=has(['юридическая услуга','юридические услуги','бухгалтерский сервис','бухгалтерское сопровождение','бюро переводов','перевод документов','legal service','accounting service']);break;
  case 'retail':proven=has(['канцелярские товары','канцелярия','офисные товары','учебные материалы','office supplies','stationery']);break;
  case 'printing':proven=has(['печать документов','фотопечать','полиграфия','рекламная печать','печать фотографий','printing','photo printing']);break;
  case 'workspace':proven=work||hint(['коворкинг','аренда офиса'],[]);break;
  case 'advertising':proven=has(['оплата рекламы','рекламное размещение','реклама','продвижение','рассылка','advertising service','advertising placement']);break;
 }
 if(!proven&&ordinaryPayment&&clearDefaults.has(p.id))proven=true;
 if(!proven)return {status:'needs_context',reason:'EXTENDED_SERVICE_CONTEXT_REQUIRED'};
 const url=/https?:\/\/\S+/u.exec(p.source)?.[0]??'';
 return {status:'recognized',profileId:p.id,entry:{name:p.name,aliases:[...p.forms],service:'unknown',source:url},literal:hits.find(h=>h.value.id===p.id)!.form,target:work&&p.target?'work_expense':p.target,parentOnly:false,provisional:false};
}
