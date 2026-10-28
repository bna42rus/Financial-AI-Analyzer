import type {Operation,Category} from './model.ts';
import {facet} from './model.ts';
import {activityDefinitions,activityGuards,activitySpecificSenses,activityContainments,fulfillmentLexicon,activityDataSha256} from './catalog/generated/activity-v1.ts';
import type {ActivityDefinition} from './catalog/generated/activity-v1.ts';
import {catalogFold,hasLiteral,literalIndex,literalNegated} from './catalog-lexical.ts';
import type {LiteralHit} from './catalog-lexical.ts';
import {resolveOwnCategory,privateCategoryTarget} from './category-resolution.ts';
import type {CategoryResolution,CategoryBindings} from './category-resolution.ts';
import {recognizeCatalogEvidence,serviceProfileDefault} from './catalog-evidence.ts';
export const activityEngineVersion='cashneuro-activity-catalog/1';
export {activityDataSha256};
export type ActivityInput={merchantText:string;description:string;bankCategory?:string;mcc?:string|null;kind:string;role:string};
export type ActivityRecognition={status:'recognized'|'unrecognized'|'needs_context'|'conflict'|'delegate_fin';activityIds:string[];targetKey:string|null;confidence:number;provisional:boolean;parentOnly:boolean;fulfillment:'delivery'|'pickup'|'unspecified'|'conflict';reason:string;profileKey:string|null;privateLabels?:readonly string[]};
const find=literalIndex(activityDefinitions.map(a=>({value:a,forms:a.forms})));
const defs=new Map(activityDefinitions.map(a=>[a.id,a]));
const guards=new Map(activityGuards.flatMap(g=>g.activity_refs.map(id=>[id,g] as const)));
const sameTarget:Readonly<Record<string,string>>={bakery:'cafe',catering:'cafe',ev:'fuel',transport_other:'logistics'};
const categoryKey=(key:string)=>sameTarget[key]??key;
function scopedText(text:string){
 // Search projection only: quoted mentions, URLs, addresses and metadata are
 // not the paid subject. The permitted bank source remains unchanged.
 return (text.split(/(?:^|[;,])\s*(?:адрес|комментарий|улица|address|comment|terminal|терминал|реклама|advertisement)\s*:/iu)[0]??'')
  .replace(/https?:\/\/\S+|www\.\S+/giu,' ')
  .replace(/[«“"][^»”"]*[»”"]/gu,' ');
}
function subjectText(text:string){
 const scoped=scopedText(text);
 if(/(?:добавь|удали|создай|измени)\s+(?:правило|категорию|операцию)/iu.test(scoped))return '';
 // Content of a book/course/site is not a merchant activity. Keep the
 // established item family before the content marker, not the mentioned words.
 return hasLiteral(scoped,['книга','книги','учебник','курс','курсы','book','course'])?(scoped.split(/(?:\s|^)(?:о|об|про|about)\s+/iu)[0]??''):scoped;
}
function sourceContext(i:ActivityInput){
 const text=subjectText(i.merchantText)+' '+subjectText(i.description),f=catalogFold(text),bank=catalogFold(i.bankCategory??'');
 const has=(forms:readonly string[])=>hasLiteral(f,forms),hint=(forms:readonly string[],mcc:readonly string[]=[])=>hasLiteral(bank,forms)||mcc.includes(i.mcc??'');
 const work=/(?:для работы|для бизнеса|рабочая цель|рабочее назначение|офисный переезд|office relocation|for work|for business)/u.test(f);
 const gift=/(?:в подарок|на подарок|подарочная цель|назначение: подарок|as a gift)/u.test(f);
 const study=/(?:учебные материалы|для уч[её]бы|учебная печать|study materials)/u.test(f);
 const child=/(?:обучение детей|детское обучение|репетитор для ребенка|репетитор для ребёнка|для школьника|child tuition)/u.test(f);
 return {text,f,bank,has,hint,work,gift,study,child,
  food:has(['кофе','coffee','снеки','снэки','снековый','кофейный','напитки','шоколад','пищевой']),
  petFood:has(['корм','корма','кормов','корм для животных','наполнитель','зоотовары','pet food','cat food','dog food']),
  medicine:has(['ветпрепарат','ветпрепараты','лекарства','лекарство','медикаменты','medicine']),
 };
}
type Context=ReturnType<typeof sourceContext>;
function allowed(hit:LiteralHit<ActivityDefinition>,c:Context):boolean{
 const g=guards.get(hit.value.id);if(!g||!g.forms.some(f=>catalogFold(f)===hit.form))return true;
 switch(g.id){
  case 'ACT-G01':return c.hint(['автосервис','ремонт автомобиля','автомобиль'],['7538','7531','7534'])||c.has(['автосервис','ремонт автомобиля','шиномонтаж']);
  case 'ACT-G02':return c.hint(['медицина','диагностика','анализы'],['8071','8099','8011'])||c.has(['медицинский центр','диагностический центр','медицинская диагностика','диагностика человека']);
  case 'ACT-G03':return !c.has(['давление','единица давления','мебель','барная стойка','publisher'])&&(c.hint(['общепит','кафе','ресторан','бар'],['5812','5813','5814'])||c.has(['кофе-бар','кофе бар','суши-бар','пицца бар','кафе','ресторан','coffee bar','sushi bar','burger bar']));
  case 'ACT-G04':return !c.has(['s.p.a.','spa hotel','спа отель','пакет отеля'])&&(c.hint(['уход','спа','красота'],['7298','7297'])||c.has(['спа-салон','спа салон','спа-центр','спа процедуры','spa salon','spa treatment']));
  case 'ACT-G05':return c.hint(['аптека','аптеки','лекарства'],['5912'])||c.has(['аптека','pharmacy']);
  case 'ACT-G06':return !c.has(['school','школа'])&&(c.hint(['фитнес','тренировки'],['7997'])||c.has(['fitness','workout','тренажерный зал','спортзал']));
  case 'ACT-G07':return !c.has(['кафе на азс','магазин на азс','мойка на азс'])&&(c.hint(['топливо','бензин','автозаправка'],['5541','5542'])||c.has(['бензин','дизельное топливо','заправка автомобиля','моторное топливо']));
  case 'ACT-G08':return c.hint(['коммунальные услуги','жкх','жку'],['4900'])||/(?:оплата|платеж|квитанция)\s+(?:жкх|жку)(?![\p{L}\p{N}_])/u.test(c.f);
  case 'ACT-G09':return !c.has(['мебель','мебельный','сервант','кухонный гарнитур'])&&(c.hint(['общепит','кафе'],['5812','5814'])||c.has(['обед','питание','кафе','столовая','готовая еда']));
  default:throw Error('UNKNOWN_ACTIVITY_GUARD');
 }
}
export function activityLiteralHits(text:string){return find(text);}
function fulfillment(c:Context):ActivityRecognition['fulfillment']{
 const negativeDelivery=/(?:без|не нужна|нужна|нужна ли|нужна будет|возможна ли)\s+доставк|доставк[а-я]*\s+(?:отменен|отменён|нет|недоступн|не нужна)|(?:no|without|cancelled)\s+delivery|delivery\s+(?:cancelled|unavailable)/u.test(c.f);
 const negativePickup=/(?:без|нужен ли)\s+самовывоз|самовывоз[а-я]*\s+(?:отменен|отменён|недоступен)|(?:no|without|cancelled)\s+pickup/u.test(c.f);
 const delivery=!negativeDelivery&&c.has(fulfillmentLexicon.affirmative_delivery_candidates??[]),pickup=!negativePickup&&c.has(fulfillmentLexicon.pickup_candidates??[]);
 return delivery&&pickup?'conflict':delivery?'delivery':pickup?'pickup':'unspecified';
}
type Routed={key:string;privateLabels?:readonly string[];parentOnly?:boolean}|{block:'needs_context'|'delegate_fin'}|null;
function route(a:ActivityDefinition,c:Context,all:readonly ActivityDefinition[],i:ActivityInput):Routed{
 if(a.mode==='SEMANTIC_TARGET'){
  if(a.domain==='FIN'&&['bank_commission','bank_service','bank_notifications'].includes(a.key)&&i.kind!=='fee')return {block:'delegate_fin'};
  return {key:a.key};
 }
 const other=()=>all.some(v=>v.id!==a.id&&v.mode==='SEMANTIC_TARGET');
 switch(a.key){
  case 'vending':return c.food?{key:'grocery',parentOnly:true}:{block:'needs_context'};
  case 'charge_context':return other()?null:c.has(['зарядное устройство','покупка пауэрбанка','покупка аккумулятора'])?{key:'electronics'}:{block:'needs_context'};
  case 'freelance_context':case 'service_context':return other()?null:{block:'needs_context'};
  case 'telephony':return {key:c.work?'business_services':'telecom_other'};
  case 'telecom_bundle':return {key:'telecom_root',parentOnly:true};
  case 'hosting':return {key:c.work?'business_services':'cloud'};
  case 'domain':return c.has(['регистрация домена','продление домена','регистратор доменов','domain registration','domain renewal','доменное имя'])?{key:c.work?'business_services':'cloud'}:{block:'needs_context'};
  case 'signature':return c.work?{key:'business_services'}:{key:'private:documents',privateLabels:['Электронная подпись','Документы','Документальные услуги']};
  case 'broad_retail':return other()?null:{block:'needs_context'};
  case 'split_context':return other()?null:{block:'needs_context'};
  case 'education_purpose':return {key:c.child?'child_education':'education'};
  case 'vet_pharmacy':return c.petFood&&!c.medicine?{key:'pet_goods'}:c.petFood&&c.medicine?{block:'needs_context'}:{key:'vet'};
  case 'flowers':return c.gift?{key:'gifts'}:{key:'private:flowers',privateLabels:['Цветы','Цветы и растения','Флористика']};
  case 'gift_card':return c.gift?{key:'gifts'}:{block:'delegate_fin'};
  case 'crowdfunding':return c.has(['пожертвование','благотворительное пожертвование','donation to charity'])?{key:'charity'}:{block:'delegate_fin'};
  case 'creator_support':return c.has(['подписка','subscription'])?{key:'subscription_other'}:{key:'private:support',privateLabels:['Поддержка авторов','Донаты авторам']};
  case 'loan_context':case 'interest_context':case 'refund_context':case 'own_transfer_context':return {block:'delegate_fin'};
  case 'moving':return {key:c.work?'work_expense':'logistics'};
  case 'pickup_context':return other()?null:{block:'needs_context'};
  case 'legal_purpose':return c.work?{key:'business_services'}:{key:'private:legal',privateLabels:['Юридические услуги','Юридическая помощь','Документальные услуги','Нотариус','Нотариальные услуги','Переводы документов','Налоговые консультации']};
  case 'administrative_context':return other()?null:{block:'needs_context'};
  case 'stationery':return c.work?{key:'work_expense'}:c.study?{key:'learning_materials'}:{key:'private:stationery',privateLabels:['Канцелярия','Канцелярские товары']};
  case 'printing':return c.work?{key:'work_expense'}:c.study?{key:'learning_materials'}:c.has(['рекламная печать','печать рекламы','advertising print'])?{key:'advertising'}:{key:'private:printing',privateLabels:['Печать','Полиграфия','Документы','Копирование']};
  case 'photo_printing':return c.work?{key:'work_expense'}:c.gift?{key:'gifts'}:{key:'private:photo',privateLabels:['Фотопечать','Фотографии']};
  default:throw Error('UNSUPPORTED_ACTIVITY_ROUTER:'+a.key);
 }
}
export function recognizeActivity(i:ActivityInput):ActivityRecognition{
 const c=sourceContext(i),method=fulfillment(c),result=(status:ActivityRecognition['status'],reason:string,ids:string[]=[],key:string|null=null,provisional=false,parentOnly=false,profileKey:string|null=null,privateLabels?:readonly string[]):ActivityRecognition=>({status,reason,activityIds:ids,targetKey:key,confidence:status==='recognized'?(provisional?80:96):0,provisional,parentOnly,fulfillment:method,profileKey,...(privateLabels?{privateLabels}:{})});
 if(i.role!=='expense'||['refund','reversal','transfer_in','transfer_out','own_transfer','credit_card_repayment','loan_payment','loan_disbursement','interest'].includes(i.kind))return result('delegate_fin','FINANCIAL_CONTEXT_REQUIRED');
 const catalog=recognizeCatalogEvidence({...i,merchantText:subjectText(i.merchantText),description:subjectText(i.description)}),profile=catalog.status==='recognized'?catalog:null,profileKey=profile?'legacy-catalog:'+profile.entry.name:null;
 if(catalog.status==='conflict')return result('conflict',catalog.reason);
 const primary=find(subjectText(i.merchantText)),body=find(subjectText(i.description));
 const positive=(h:LiteralHit<ActivityDefinition>,text:string)=>!literalNegated(text,h);
 const eligiblePrimary=primary.filter(h=>allowed(h,c)&&positive(h,subjectText(i.merchantText)));
 const eligibleBody=body.filter(h=>allowed(h,c)&&positive(h,subjectText(i.description)));
 const hits=[...eligiblePrimary,...eligibleBody];
 // Specific meaning dominates only a physically nested phrase in that same
 // field; it never suppresses an independent paid subject by array order.
 const ids=new Set(hits.map(h=>h.value.id));
 const nested=(outer:string,inner:string)=>[eligiblePrimary,eligibleBody].some(field=>field.some(a=>a.value.id===outer&&allowed(a,c)&&field.some(b=>b.value.id===inner&&allowed(b,c)&&a.from<=b.from&&a.through>=b.through)));
 for(const edge of [...activitySpecificSenses.map(e=>({outer:e.specific,inner:e.broad})),...activityContainments])if(ids.has(edge.outer)&&ids.has(edge.inner)&&nested(edge.outer,edge.inner))ids.delete(edge.inner);
 // A medical centre is a provider, while an explicit diagnostic/dental
 // service at that centre is the paid subject. An independent doctor visit
 // remains a competing service, not a longest-string tie breaker.
 if((ids.has('ACT-HEALTH06')||ids.has('ACT-HEALTH03'))&&hits.filter(h=>h.value.id==='ACT-HEALTH02').every(h=>['медицинский центр','медицинского центра','медицинском центре','клиника','клиники','клинике','medical center','clinic'].includes(h.form)))ids.delete('ACT-HEALTH02');
 const selected=[...ids].map(id=>defs.get(id)!);
 const routed=selected.map(a=>({id:a.id,value:route(a,c,selected,i)}));
 const separateCourier=/(?:отдельная оплата|отдельно оплаченная|плата за|оплата услуг|услуга:)\s*(?:курьер|доставк)|separate courier fee/u.test(c.f);
 if(separateCourier)return result('recognized','SEPARATE_COURIER_FEE',[...ids],c.work?'work_expense':'logistics',false,false,profileKey);
 const definite=routed.filter((v):v is {id:string;value:{key:string;privateLabels?:readonly string[];parentOnly?:boolean}}=>!!v.value&&'key' in v.value);
 const blocks=routed.filter(v=>v.value&&'block' in v.value);
 if(blocks.some(v=>v.value&&'block' in v.value&&v.value.block==='delegate_fin'))return result('delegate_fin','FINANCIAL_RULE_REQUIRED',[...ids]);
 let choices=[...new Map(definite.map(v=>[categoryKey(v.value.key),v.value])).values()];
 // An established actual pet-food subject is distinct from the shop's vet profile.
 if(choices.some(v=>v.key==='pet_goods')&&choices.some(v=>v.key==='vet')&&!c.medicine)choices=choices.filter(v=>v.key!=='vet');
 if(choices.length>1)return result('conflict','MULTIPLE_PAID_SUBJECTS',[...ids]);
 if(choices.length===1){const choice=choices[0]!;
  if(blocks.length&&!selected.every(a=>a.key==='charge_context'||a.key==='broad_retail'||a.key==='freelance_context'||a.key==='service_context'||a.key==='pickup_context'||a.mode==='SEMANTIC_TARGET'))return result('needs_context','CONDITIONAL_SUBJECT_UNRESOLVED',[...ids]);
  let key=categoryKey(choice.key);if(c.work&&!['business_services','work_expense','advertising'].includes(key)&&!selected.some(a=>a.domain==='FIN'))key=['cloud','software','ai','vpn','video'].includes(key)?'business_services':'work_expense';
  if(method==='delivery'){if(key==='grocery')key='grocery_delivery';if(key==='cafe')key='meal_delivery';}
  const defaultProfile=serviceProfileDefault(subjectText(i.merchantText)),provisional=profile?.provisional&&profile.target===key||defaultProfile?.provisional&&defaultProfile.target===key||false;
  return result('recognized','ACTUAL_ACTIVITY',[...ids],key,provisional,choice.parentOnly||method==='conflict',profileKey,choice.privateLabels);
 }
 if(blocks.length){
  // A known Go/portable charge context gives a visible provisional suggestion,
  // rather than silently defaulting the word charge to a completed taxi ride.
  if(profile?.entry.name==='Яндекс Go'&&selected.some(a=>a.key==='charge_context'))return result('recognized','Yandex_PORTABLE_SERVICE_NOT_EXPLICIT',[...ids],'powerbank',true,false,profileKey);
  return result('needs_context','ACTIVITY_CONTEXT_NOT_ESTABLISHED',[...ids]);
 }
 const specific=serviceProfileDefault(subjectText(i.merchantText));
 if(specific){let key=specific.target;if(method==='delivery'&&key==='grocery')key='grocery_delivery';return result('recognized','KNOWN_SERVICE_PROFILE',[],key,specific.provisional,method==='conflict',profileKey);}
 if(profile?.target){let key=profile.target;if(profile.entry.delivery&&method!=='pickup'&&method!=='conflict'||method==='delivery'){if(key==='grocery')key='grocery_delivery';if(key==='cafe')key='meal_delivery';}return result('recognized','KNOWN_MERCHANT_PROFILE',[],key,profile.provisional,profile.parentOnly||method==='conflict',profileKey);}
 if(primary.length||body.length||find(i.merchantText).length||find(i.description).length||catalog.status==='needs_context')return result('needs_context','LITERAL_REQUIRES_CONTEXT');
 return result('unrecognized','NO_ACTIVITY_EVIDENCE');
}
const specialTargets={telecom_root:{key:'telecom_root',path:['Связь и интернет'],labels:['Связь и интернет','Связь']},telecom_other:{key:'telecom_other',path:['Связь и интернет','Прочая связь'],labels:['Прочая связь','Телефония']},education:{key:'education',path:['Образование','Обучение'],labels:['Обучение']},subscription_other:{key:'subscription_other',path:['Подписки и цифровые сервисы','Прочие подписки'],labels:['Прочие подписки']}};
export function resolveActivityCategory(e:ActivityRecognition,categories:readonly Category[],bindings?:CategoryBindings):CategoryResolution{
 if(e.status!=='recognized'||!e.targetKey)return {status:'missing',reason:e.reason};
 const target=e.privateLabels?privateCategoryTarget(e.targetKey,e.privateLabels):specialTargets[e.targetKey as keyof typeof specialTargets];
 return resolveOwnCategory(e.targetKey,categories,'expense',{bindings,parentOnly:e.parentOnly,...(target?{target}:{})});
}
const protectedFacet=(v:{userVerified:boolean;source:string})=>v.userVerified||['user','personal_rule','global_rule'].includes(v.source);
export function activityDecision(operation:Operation,categories:readonly Category[]){
 const s=operation.source;
 if(s.versions.sourceSanitizer!=='bank-source/5')return null;
 if(s.versions.sourceTextEvidence!=='intact')return {evidence:null,resolution:{status:'missing',reason:'UNTRUSTED_LITERAL_BOUNDARIES'} as CategoryResolution};
 const evidence=recognizeActivity({merchantText:s.merchantText,description:s.description,bankCategory:s.bankCategory,mcc:s.sourceMcc,kind:operation.semantics.kind.value,role:operation.semantics.role.value});
 return {evidence,resolution:resolveActivityCategory(evidence,categories)};
}
/** Only category facets of eligible whole operations. Source, money, merchant,
 * roles, user decisions and parts remain byte-equivalent. */
export function applyActivityRecognition(operation:Operation,categories:readonly Category[]):Operation{
 const next=structuredClone(operation),s=next.semantics;
 if(next.decomposition||next.semantics.role.value!=='expense'||protectedFacet(s.category)||protectedFacet(s.subcategory)||s.category.value!==null&&s.category.source==='deterministic_system_rule')return next;
 const decision=activityDecision(next,categories);if(!decision?.evidence||decision.evidence.status!=='recognized'||decision.resolution.status!=='resolved')return next;
 const {evidence,resolution}=decision;
 next.semantics.category=facet(resolution.categoryId,'global_rule',false,evidence.confidence);next.semantics.subcategory=facet(resolution.subcategoryId,'global_rule',false,evidence.confidence);
 if(evidence.provisional)next.reviewReasons=[...new Set([...next.reviewReasons,'low_category_confidence'])];else next.reviewReasons=next.reviewReasons.filter(r=>r!=='low_category_confidence');
 return next;
}
