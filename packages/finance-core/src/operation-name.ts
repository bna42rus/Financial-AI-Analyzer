import type {Operation} from './model.ts';
import {cleanBankText} from '../../imports/src/bank-description.ts';
import {recognizeCatalogEvidence} from './catalog-evidence.ts';
import {recognizeActivity} from './activity-recognition.ts';
import {catalogFold} from './catalog-lexical.ts';
import {nameStyles,nameDataSha256,extendedCatalogSha256} from './catalog/generated/name-v1.ts';
export {nameDataSha256,extendedCatalogSha256};
export const operationNameVersion='cashneuro-operation-name/1';
export type OperationDisplayName={version:typeof operationNameVersion;title:string;eventLabel:string|null;serviceQualifier:string|null;fulfillmentQualifier:string|null;viaLabel:string|null;compositeLabel:string;safeBankDescriptionRef:{operationId:string;field:'source.description'};explanationCode:string};
/** Trusted adapter projection only; never accepted from an HTTP/Registry input.
 * Every consumed character belongs to the exact current permitted source field.
 * The existing adapters provide no branch/geo/channel metadata, so production
 * calls deliberately omit this argument instead of guessing such segments. */
export type NameSegments={source:string;merchant:{from:number;through:number};technical:readonly {from:number;through:number;kind:'event'|'channel'|'geo'|'branch'|'legal'}[];origin:'bank-adapter/1'};
export type NameContext={counterparties?:readonly {id:string;name:string;mergedIntoId?:string|null}[];segments?:NameSegments};
const styleKeys:Readonly<Record<string,string>>={'Ворлд Класс':'World Class','Спирит Фитнес':'Spirit Fitness','LOG003':'СДЭК','LOG018':'5Post','LOG019':'B2CPL','LOG021':'Яндекс Доставка','OFF014':'Space 1'};
const styles=new Map(nameStyles.map(s=>[s.profile,s]));
const events:Readonly<Record<string,string>>={purchase:'Покупка',refund:'Возврат',reversal:'Отмена',transfer_in:'Перевод',transfer_out:'Перевод',own_transfer:'Перевод',fee:'Комиссия банка',cash_withdrawal:'Снятие наличных',cash_deposit:'Внесение наличных',credit_card_repayment:'Погашение кредитной карты',loan_payment:'Погашение кредита',loan_disbursement:'Выдача кредита',interest:'Проценты',cashback:'Кешбэк',insurance:'Страхование',other:'Операция'};
const meaningful=(s:string)=>/[\p{L}\p{N}]/u.test(s.replaceAll('[скрыто]',''));
const script=(s:string)=>{const latin=/\p{Script=Latin}/u.test(s),cyrillic=/\p{Script=Cyrillic}/u.test(s);return latin&&cyrillic?'Mixed':latin?'Latin':cyrillic?'Cyrillic':null;};
function segmented(source:string,proof:NameSegments|undefined):string|null{
 if(!proof||proof.origin!=='bank-adapter/1'||proof.source!==source)return null;
 const ranges=[{...proof.merchant,kind:'merchant'},...proof.technical].sort((a,b)=>a.from-b.from);let end=0;
 for(const r of ranges){if(!Number.isInteger(r.from)||!Number.isInteger(r.through)||r.from<end||r.through<=r.from||r.through>source.length||/[^\s:;,.*_—–-]/u.test(source.slice(end,r.from)))return null;end=r.through;}
 if(/[^\s:;,.*_—–-]/u.test(source.slice(end)))return null;
 return source.slice(proof.merchant.from,proof.merchant.through).trim()||null;
}
function composite(fields:Pick<OperationDisplayName,'title'|'eventLabel'|'serviceQualifier'|'fulfillmentQualifier'|'viaLabel'>){
 const values:string[]=[];for(const value of [fields.eventLabel,fields.title,fields.serviceQualifier,fields.fulfillmentQualifier,fields.viaLabel?`через ${fields.viaLabel}`:null])if(value&&!values.some(v=>catalogFold(v)===catalogFold(value)))values.push(value);
 return values.join(' — ');
}
/** A pure view of already authorized, current owner state. No cache, model,
 * network, grouping, rule matching or writes of any bank/semantic field. */
export function operationDisplayName(op:Operation,context:NameContext={}):OperationDisplayName{
 const source=op.source,name=op.semantics.merchant,kind=op.semantics.kind.value,protectedName=name.userVerified||['user','personal_rule','global_rule'].includes(name.source);
 const raw=cleanBankText(source.merchantText,160),description=cleanBankText(source.description),intact=source.versions.sourceSanitizer==='bank-source/5'&&source.versions.sourceTextEvidence==='intact';
 let title=protectedName?cleanBankText(name.value,160):intact?(raw||cleanBankText(name.value,160)):(cleanBankText(name.value,160)||raw),explanationCode=protectedName?'NAME-R02':'NAME-R11';
 let serviceQualifier:string|null=null,fulfillmentQualifier:string|null=null;
 if(!protectedName&&intact&&raw){
  const projected=segmented(raw,context.segments);if(projected){title=projected;explanationCode='NAME-P03';}
  const activity=recognizeActivity({merchantText:raw,description,bankCategory:source.bankCategory,mcc:source.sourceMcc,kind,role:op.semantics.role.value});
  // Fulfillment describes the same actual paid order, not a category inference.
  const method=kind==='purchase'&&op.semantics.role.value==='expense'&&activity.status==='recognized'?activity.fulfillment:'unspecified';
  if(method==='delivery'||method==='pickup'){
   fulfillmentQualifier=method==='delivery'?'Доставка':'Самовывоз';
   const ending=method==='delivery'?/(?:\s*[,;:—-]?\s+)(?:доставка(?: бесплатно)?|доставкой|delivery|home delivery|курьерская доставка)$/iu:/(?:\s*[,;:—-]?\s+)(?:самовывоз|самовывозом|pickup|pick-up|click and collect)$/iu;
   title=title.replace(ending,'').trim()||title;
  }
  if(['legacy-catalog:Яндекс Go','catalog-v1:R01'].includes(activity.profileKey??'')&&activity.targetKey==='powerbank'){
   const m=/^(.+?)(?:\s*:\s*|\s+)(аренда пауэрбанка|аренда зарядки)$/iu.exec(title);if(m){title=m[1]!;serviceQualifier='Аренда пауэрбанка';}
  }
  const evidence=recognizeCatalogEvidence({merchantText:title,description,bankCategory:source.bankCategory,mcc:source.sourceMcc});
  // A whole permitted merchant span is required. Merely finding a brand inside
  // an unknown longer trade name does not authorize dropping the remainder.
  if(evidence.status==='recognized'&&evidence.entry.aliases.some(alias=>catalogFold(alias)===catalogFold(title))){
   const matchedTitle=title;
   const key=styleKeys[evidence.profileId??'']??styleKeys[evidence.entry.name]??evidence.entry.name,style=styles.get(key),alphabet=script(title);
   const label=style&&alphabet?style.labels[alphabet]:undefined;
   if(label){title=cleanBankText(label,160);explanationCode=style!.id;}
   if(evidence.entry.name==='TimeWeb'&&/cloud$/iu.test(matchedTitle)){serviceQualifier='Cloud';title='TimeWeb';explanationCode='NAME-S01';}
  }
  // A service name is not automatically another delivery/pickup event.
  if(fulfillmentQualifier&&catalogFold(title).includes(catalogFold(fulfillmentQualifier)))fulfillmentQualifier=null;
 }
 let eventLabel=kind==='purchase'?null:events[kind]??'Операция';
 if(!meaningful(title)){
  const party=op.semantics.counterparty.value?context.counterparties?.find(p=>p.id===op.semantics.counterparty.value&&!p.mergedIntoId):null;
  title=party?cleanBankText(party.name,160):'';
  if(!meaningful(title)&&['transfer_in','transfer_out','own_transfer'].includes(kind)){
   title=description.replace(/^(?:(?:входящий|исходящий|внутренний|денежный|банковский)\s+)?перевод(?:\s*[:—-]\s*|\s+)|^(?:(?:incoming|outgoing|bank|money|internal)\s+)?transfer\s*/iu,'').trim();
   if(title===description)title='';title=cleanBankText(title,160);
  }
  if(!meaningful(title)&&description){
   const subject=description.replace(/^(?:оплата товаров и услуг|оплата покупки|покупка(?: в)?|оплата услуг|оплата в|оплата по карте|оплата картой|purchase|card payment|возврат покупки|возврат средств за покупку|возврат оплаты|purchase refund|refund)(?=$|[^\p{L}\p{N}_])\s*[:.-]?\s*/iu,'');
   if(meaningful(subject))title=cleanBankText(subject,160);
  }
  if(!meaningful(title)){title=kind==='purchase'?'Продавец не определён':events[kind]??'Операция';if(kind==='purchase')eventLabel='Покупка';}
  explanationCode='NAME-R12';
 }
 title=cleanBankText(title,160);if(eventLabel&&catalogFold(eventLabel)===catalogFold(title))eventLabel=null;
 const result:OperationDisplayName={version:operationNameVersion,title,eventLabel,serviceQualifier,fulfillmentQualifier,viaLabel:null,compositeLabel:'',safeBankDescriptionRef:{operationId:op.id,field:'source.description' as const},explanationCode};
 result.compositeLabel=cleanBankText(composite(result),1000);return result;
}
