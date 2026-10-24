import {facet} from './model.ts';
import type {Operation,Category} from './model.ts';
import {merchantCatalog,merchantCatalogVersion} from './merchant-catalog.ts';
import type {MerchantService} from './merchant-catalog.ts';
export {merchantCatalogVersion};
const letters:Record<string,string>={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
export const merchantKey=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[а-яё]/gu,c=>letters[c]!).replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const words=(text:string)=>new Set(merchantKey(text).split(' '));
const contains=(text:string,alias:string)=>(' '+text+' ').includes(' '+merchantKey(alias)+' ');
const boundaryPattern=(alias:string)=>{
 const key=merchantKey(alias),escaped=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 // Branch digits may follow a complete brand. Never match SPAR inside SPARK.
 return new RegExp('(?:^| )'+escaped+'(?=$| |[0-9])');
};
const catalogPatterns=merchantCatalog.map(entry=>({entry,patterns:entry.aliases.map(boundaryPattern)}));
const genericPrefixes=/^(?:(?:покупка(?: в)?|оплата(?: товаров и услуг| покупки| по карте| картой| в)?|возврат покупки|purchase|card payment|sber[ _-]*\d*(?:[,.]\d+)?|сбер[ _-]*\d*(?:[,.]\d+)?)[ :.*_-]+)+/iu;
const locationTail=/(?:[ ,_*.-]+(?:moscow|moskva|москва|sankt[ -]?peterburg|saint[ -]?petersburg|санкт[ -]?петербург|innopolis|иннополис|rus|рус|russia|россия))+(?:[ ,_*.-]*)$/iu;
export type MerchantRecognition={name:string;service:MerchantService|null;confidence:number;delivery:boolean;matched:boolean;conflict:boolean};
/** Only merchant/service text: no dates, amounts, IDs or bank-city assumptions. */
export function recognizeMerchant(merchant:string,description=''):MerchantRecognition{
 const original=merchant.trim()||description.trim().replace(genericPrefixes,'');
 const clean=original.replace(genericPrefixes,'').replace(locationTail,'').trim(),key=merchantKey(clean);
 const base:MerchantRecognition={name:clean||original,service:null,confidence:0,delivery:false,matched:false,conflict:false};
 if(!key||/\b(?:perevod|transfer|sbp)\b/.test(merchantKey(description))&&!merchant)return base;
 const found=catalogPatterns.filter(e=>e.patterns.some(pattern=>pattern.test(key))).map(e=>e.entry);
 // Specific Yandex services win over the broad platform; unrelated brands conflict.
 const specific=found.filter(e=>!found.some(other=>other.parentBrand===e.name));
 const unique=[...new Map(specific.map(e=>[e.name,e])).values()];
 if(unique.length>1){return {...base,conflict:true};}
 const entry=unique[0];
 const tokens=words(clean),full=merchantKey(description+' '+merchant);
 const delivery=/(?:^| )(?:dostavka|dostavki|delivery|dostavkaiz)(?: |$)/u.test(full);
 if(entry){
  // Telecom brands also sell hardware; explicit different product evidence wins by abstention.
  const contradictory=entry.service==='telecom'&&/\b(?:smartfon|smartphone|noutbuk|notebook|televizor|strahovanie|kredit)\b/.test(full);
  return {name:entry.name,service:contradictory?null:entry.service,confidence:contradictory?0:entry.review?80:96,delivery:delivery||!!entry.delivery,matched:true,conflict:contradictory};
 }
 const services:Array<[MerchantService,string[]]>=[
  ['cafe',['кафе','cafe','kafe','кофейня','kofeynya','столовая','stolovaya','stolovaja','ресторан','restaurant','restoran','кафетерий','закусочная','пиццерия','pizzeria']],
  ['pharmacy',['аптека','apteka','pharmacy']],['fitness',['фитнес','fitness','fitnes','спортзал','тренажерный зал']],
  ['fuel',['азс','azs','бензин','автозаправка']],['medical',['клиника','klinika','стоматология','stomatologiya','лаборатория']],
  ['cinema',['кинотеатр','kinoteatr','cinema']],['books',['книжный магазин','knizhnyy magazin']],
  ['pets',['зоомагазин','zoomagazin']],['veterinary',['ветклиника','vetklinika','ветеринарная клиника','veterinarnaya klinika','ветеринар','veterinar']],['beauty',['парикмахерская','parikmaherskaya','barbershop','барбершоп','салон красоты']],
  ['clothing',['магазин одежды','magazin odezhdy','обувной магазин']],['home',['мебельный магазин','строительный магазин']],
  ['education',['учебный центр','школа языков','образовательные курсы']],['hotel',['отель','otel','hotel','гостиница']],
  ['rail',['жд билеты','железнодорожные билеты']],['air',['авиабилеты']],
  ['public_transport',['общественный транспорт','городской автобус']],['carsharing',['каршеринг','carsharing']],
 ];
 const activityMatches=services.filter(([,aliases])=>aliases.some(a=>contains(key,a)));
 const matches=activityMatches.some(([service])=>service==='veterinary')?activityMatches.filter(([service])=>service!=='medical'):activityMatches;
 if(matches.length===1)return {...base,service:matches[0]![0],confidence:95,delivery,matched:true};
 if(matches.length>1)return {...base,conflict:true};
 // Vending can be embedded in a compound trade name, but is only a Review suggestion.
 if(/vending|вендинг/iu.test(clean))return {...base,service:'grocery',confidence:75,delivery:false,matched:true};
 // Bounded one-edit spelling tolerance for long activity words; never fuzzy-match a brand.
 const distanceOne=(a:string,b:string)=>{if(Math.abs(a.length-b.length)>1)return false;let i=0,j=0,edits=0;while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++edits>1)return false;if(a.length>=b.length)i++;if(b.length>=a.length)j++;}return edits+(i<a.length||j<b.length?1:0)===1;};
 const fuzzy=services.filter(([,aliases])=>aliases.some(a=>{const k=merchantKey(a);return k.length>=6&&!k.includes(' ')&&[...tokens].some(t=>t.length>=6&&distanceOne(k,t));}));
 if(fuzzy.length===1)return {...base,service:fuzzy[0]![0],confidence:78,delivery,matched:true};
 return base;
}
const routes:Record<MerchantService,{roots:string[];leaves:string[]}>= {
 grocery:{roots:['Продукты'],leaves:['Магазины','Супермаркеты']},cafe:{roots:['Еда вне дома','Кафе и рестораны','Рестораны и кафе'],leaves:['Кофейни','Рестораны и кафе','Кафе и рестораны']},
 fitness:{roots:['Здоровье и спорт','Спорт','Фитнес и спорт'],leaves:['Фитнес и спорт','Фитнес','Спортивные товары']},
 telecom:{roots:['Связь и интернет','Связь'],leaves:[]},public_transport:{roots:['Транспорт','Общественный транспорт'],leaves:['Общественный транспорт']},
 carsharing:{roots:['Транспорт','Каршеринг'],leaves:['Каршеринг']},powerbank:{roots:['Аренда пауэрбанков','Пауэрбанки','Прочие расходы'],leaves:['Аренда пауэрбанков','Пауэрбанки']},
 marketplace:{roots:['Маркетплейсы','Покупки на маркетплейсах','Прочие расходы'],leaves:['Маркетплейсы']},cloud:{roots:['Подписки и цифровые сервисы','Цифровые сервисы'],leaves:['Облачные сервисы','Хостинг']},
 pharmacy:{roots:['Здоровье и спорт','Здоровье','Аптеки'],leaves:['Аптеки']},fuel:{roots:['Транспорт','Автомобиль','Топливо'],leaves:['Топливо','Бензин']},
 cinema:{roots:['Развлечения и хобби','Развлечения'],leaves:['Кино и мероприятия','Кино']},books:{roots:['Развлечения и хобби','Книги'],leaves:['Книги']},
 veterinary:{roots:['Питомцы','Домашние животные'],leaves:['Ветеринар','Ветеринарные услуги']},pets:{roots:['Питомцы','Домашние животные'],leaves:['Корм и товары']},home:{roots:['Жильё и дом','Дом'],leaves:['Товары для дома']},
 clothing:{roots:['Одежда и аксессуары','Одежда'],leaves:['Одежда']},electronics:{roots:['Электроника','Техника'],leaves:[]},
 beauty:{roots:['Красота и уход','Красота'],leaves:['Парикмахерские и салоны']},medical:{roots:['Здоровье и спорт','Здоровье'],leaves:['Врачи']},
 rail:{roots:['Путешествия'],leaves:['Ж/д билеты']},air:{roots:['Путешествия'],leaves:['Авиабилеты']},hotel:{roots:['Путешествия'],leaves:['Отели']},
 cosmetics:{roots:['Красота и уход','Красота'],leaves:['Косметика и уход']},laboratory:{roots:['Здоровье и спорт','Здоровье'],leaves:['Анализы и диагностика']},
 education:{roots:['Образование'],leaves:['Курсы','Обучение']},unknown:{roots:[],leaves:[]}
};
export function merchantCategory(recognition:MerchantRecognition,categories:Category[]){
 if(!recognition.service||recognition.conflict)return null;
 const available=categories.filter(c=>!c.hidden&&(c.role==='expense'||c.role==='both'));
 const choose=(names:string[],parent:string|null)=>{for(const name of names){const found=available.filter(c=>c.parentId===parent&&merchantKey(c.name)===merchantKey(name));if(found.length>1)return null;if(found[0])return found[0];}return null;};
 const route=routes[recognition.service],category=choose(route.roots,null);if(!category)return null;
 let leaves=route.leaves;
 if(recognition.service==='grocery')leaves=recognition.confidence<90?['Прочие продукты']:recognition.delivery?['Доставка продуктов']:route.leaves;
 if(recognition.service==='cafe'&&recognition.delivery)leaves=['Доставка готовой еды'];
 else if(recognition.service==='cafe'&&!['Маковка','Буханка','Кофемания','Шоколадница','Кофикс','Даблби'].includes(recognition.name)&&!/kofeyn|coffee/u.test(merchantKey(recognition.name)))leaves=['Рестораны и кафе','Кафе и рестораны'];
 if(recognition.name==='Спортмастер')leaves=['Спортивные товары'];
 const sub=choose(leaves,category.id);
 return {categoryId:category.id,subcategoryId:sub?.id??null,confidence:recognition.confidence};
}
const protectedFacet=(f:{userVerified:boolean;source:string})=>f.userVerified||['user','personal_rule','global_rule'].includes(f.source);
/** For new imports or an explicit classification pass. Never touches bank facts,
 * manual/rule/verified facets, components, monetary roles or links. */
export function applyMerchantRecognition(operation:Operation,categories:Category[]):Operation{
 const next=structuredClone(operation);
 if(next.source.versions.sourceSanitizer!=='bank-source/4')return next;
 const recognition=recognizeMerchant(next.source.merchantText,next.source.description);
 if(!protectedFacet(next.semantics.merchant)&&recognition.name&&next.source.merchantText)next.semantics.merchant=facet(recognition.name,'deterministic_system_rule',false,recognition.matched?recognition.confidence:80);
 const category=next.semantics.category,sub=next.semantics.subcategory;
 if(next.semantics.role.value!=='expense'||next.decomposition||protectedFacet(category)||protectedFacet(sub)||category.value!==null&&category.source==='deterministic_system_rule')return next;
 const decision=merchantCategory(recognition,categories);if(!decision)return next;
 next.semantics.category=facet(decision.categoryId,'global_rule',false,decision.confidence);
 next.semantics.subcategory=facet(decision.subcategoryId,'global_rule',false,decision.confidence);
 if(decision.confidence>=90)next.reviewReasons=next.reviewReasons.filter(r=>r!=='low_category_confidence');
 else next.reviewReasons=[...new Set([...next.reviewReasons,'low_category_confidence'])];
 return next;
}
