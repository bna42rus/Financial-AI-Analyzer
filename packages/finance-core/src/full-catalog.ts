import {fullCatalogProfiles,fullCatalogDataSha256} from './catalog/generated/profiles-v1.ts';
import type {FullCatalogProfile} from './catalog/generated/profiles-v1.ts';
import {literalIndex,hasLiteral,literalNegated,catalogFold} from './catalog-lexical.ts';
import type {CatalogInput,CatalogEvidence} from './catalog-evidence.ts';
export {fullCatalogDataSha256,fullCatalogProfiles};
const index=literalIndex(fullCatalogProfiles.filter(p=>p.active).map(p=>({value:p,forms:p.forms})));
export const fullCatalogHits=(text:string)=>index(text);
const clues:Readonly<Record<string,readonly string[]>>={subject:['подписка на по','лицензия на программное обеспечение','программное обеспечение','покупка товара','оплата api','api usage','корм для животных','аренда жилья'],food:['кафе','кофейня','ресторан','общепит','столовая','пекарня','суши','пицца','coffee','restaurant','cafe','sushi','pizza'],transport:['такси','taxi','каршеринг','carsharing','городской проезд','автобус','метрополитен','парковка','parking','азс','бензин','топливо','автосервис','шиномонтаж','автомойка'],powerbank:['пауэрбанк','пауэрбанка','аренда зарядки','прокат зарядки','powerbank','powerbank rental'],health:['аптека','аптеке','pharmacy','клиника','клиники','медицинский центр','clinic','стоматология','стоматологии','стоматолог','dental','оптика','оптике','optika','optics','линзы','ортопедия','слуховые аппараты','медицинская лаборатория','анализ крови'],sport:['фитнес','fitness','спортзал','тренажерный зал','тренировки','йога','пилатес','скалодром','спортивный магазин','спорттовары','спортпит'],home:['строительный магазин','стройматериалы','ремонт квартиры','магазин мебели','мебель','кухня','товары для дома','коммунальные услуги','жкх','жку','уборка жилья','клининг'],fashion:['магазин одежды','одежда','одежды','обувь','обуви','fashion','clothing','аксессуары','ювелирный магазин','украшения','детская одежда'],beauty:['магазин косметики','косметика','косметики','cosmetics','парикмахерская','салон красоты','barbershop','барбершоп','маникюр','эпиляция','ногтевая студия'],telecom:['мобильная связь','мобильный тариф','домашний интернет','телеком','telecom','абонентская плата','абонплата','интернет провайдер'],digital:['подписка','subscription','лицензия','license','облачный сервис','hosting','хостинг','продление домена','оплата api','api usage','chatgpt plus','chatgpt pro','ai сервис','ии сервис','vpn'],retail:['магазин','покупка товара','заказ товара','товарный заказ','shop','retail','маркетплейс'],entertainment:['билет','билеты','кинотеатр','театр','музей','сеанс','выставка','концерт','квест','игровой клуб','книжный магазин','хобби гипермаркет'],education:['обучение','учеба','учёба','образовательный курс','школьное обучение','репетитор','детский сад','детская секция','учебные материалы'],travel:['авиабилет','авиабилеты','перелет','перелёт','flight','билет на поезд','железнодорожный билет','проживание','бронирование отеля','hotel booking','турпакет','круиз','прокат автомобиля'],pet:['зоомагазин','зоотовары','pet shop','корм для животных','ветеринарная клиника','ветклиника','ветеринар','груминг','выгул собаки','передержка'],gift:['цветочный магазин','букет','цветочная композиция','подарок','пожертвование','благотворительный взнос','charity donation']};
const codes:Readonly<Record<string,readonly string[]>>={cafe:['5812','5813','5814'],taxi:['4121'],public:['4111','4131'],carshare:['7512'],fuel:['5541','5542','5552'],parking:['7523','4784'],auto_service:['7531','7534','7538','7542'],pharmacy:['5912'],doctors:['8011','8099'],diagnostics:['8071'],dentistry:['8021'],optics:['8043'],medical_devices:['5975'],fitness:['7997'],sport_goods:['5941'],home_repair:['5200','5211','5231','5251'],home_goods:['5712','5719','5714'],utilities:['4900'],household_service:['7210','7216','7349','7251'],clothes:['5651','5691'],shoes:['5661'],accessories:['5944','5948'],cosmetics:['5977'],salon:['7230'],care_other:['7298','7297'],electronics:['5732'],events:['7832','7922','7991'],ent_other:['7996'],books:['5942'],courses:['8299'],child_education:['8211'],air:['4511'],rail:['4112'],hotel:['7011'],tours:['4722'],pet_goods:['5995'],vet:['0742']};
const locals:Readonly<Record<string,readonly string[]>>={H076:['чувашия','чебоксары'],H078:['татарстан','казань'],H079:['воронеж'],H080:['пермь','пермский край'],FS006:['нижний новгород','нижегородская'],FS015:['краснодар'],FS024:['екатеринбург'],FS082:['череповец'],H041:['пресня','пресне','рассвет клиника']};
const parentProfiles:Readonly<Record<string,string>>={DIG007:'MP001',DIG008:'MP002',DIG003:'NET001',DIG097:'DIG045',TRV045:'NET001'};
// These are explicit service identities within a previously broader legacy brand.
export const supersededLegacy:Readonly<Record<string,readonly string[]>>={HOME002:['Лента'],H009:['Магнит'],BEA007:['Магнит'],DIG007:['Ozon'],DIG008:['Wildberries'],TRV045:['МТС']};
function eligible(p:FullCatalogProfile,i:CatalogInput,literals:readonly string[]){
 const text=i.merchantText+' '+i.description,has=(forms:readonly string[])=>hasLiteral(text,forms),context=has(clues[p.guard]??[])||hasLiteral(i.bankCategory??'',clues[p.guard]??[])||(codes[p.target??'']??[]).includes(i.mcc??'');
 if(locals[p.id]&&!has(locals[p.id]!))return false;
 if(p.requiresContext&&!context)return false;
 // Product manufacturers are not an independently established retailer/payee.
 if(p.guard==='subject'&&!context&&!has(['оплата услуги','покупка товара','подписка','обучение','аренда автомобиля','аренда жилья','пожертвование','ветеринарная услуга']))return false;
 // Don't treat only the single-letter historical restaurant brand as identity.
 if(p.id==='F49'&&literals.every(f=>catalogFold(f).length===1))return false;
 if(p.id==='R28'&&!has(['самокат','самокаты','велосипед','велосипеды','аренда самоката','kicksharing']))return false;
 if(p.id==='PB02'&&!has(clues.powerbank!))return false;
 // Qualified names keep their service. A generic cafe or pharmacy hint cannot
 // resolve two distinct, otherwise identical common-name organizations.
 if(p.id==='H010'&&!has(['аптека','аптеки','аптеке','pharmacy'])&&i.mcc!=='5912')return false;
 if(p.id==='H039'&&!has(['клиника','клиники','clinic'])&&!['8011','8099'].includes(i.mcc??''))return false;
 return true;
}
function targetFor(p:FullCatalogProfile,i:CatalogInput){
 const text=i.merchantText+' '+i.description;
 const has=(forms:readonly string[])=>hasLiteral(text,forms);
 if(p.guard==='telecom'){
  if(has(['покупка телефона','покупка роутера','покупка смартфона','оборудование']))return null;
  if(has(['мобильная связь','мобильный тариф','мобильный интернет']))return 'mobile';
  if(has(['домашний интернет','доступ в интернет','абонплата за интернет']))return 'internet';
  // Multi-service operators retain the broad agreed parent without claiming a product.
  if(['NET001','NET002','NET003','NET017','NET018','NET020','NET021','NET022','NET035'].includes(p.id))return 'telecom_root';
 }
 if(p.id==='R01'&&has(['такси','taxi']))return 'taxi';
 if(p.id==='GFT001'&&has(['подарок','подарочный букет','подарочная композиция']))return 'gifts';
 if(p.id==='HOME058'&&has(['арендная плата','плата за аренду жилья','аренда квартиры']))return 'rent';
 if(p.id.startsWith('PET')&&p.guard==='subject'&&has(['корм для животных','корм для собак','корм для кошек']))return 'pet_goods';
 if(p.guard==='subject'&&!p.target)return null;
 return p.target;
}
export function fullCatalogEvidence(i:CatalogInput):CatalogEvidence{
 const all=index(i.merchantText),hits=all.filter(h=>!literalNegated(i.merchantText,h));
 if(!hits.length)return {status:all.length?'needs_context':'none',reason:all.length?'NEGATED_FULL_PROFILE':'NO_FULL_PROFILE'};
 const ids=[...new Map(hits.map(h=>[h.value.id,h.value])).values()];
 let eligibleProfiles=ids.filter(p=>eligible(p,i,hits.filter(h=>h.value.id===p.id).map(h=>h.form)));
 eligibleProfiles=eligibleProfiles.filter(p=>!eligibleProfiles.some(child=>parentProfiles[child.id]===p.id));
 const groups=[...new Set(eligibleProfiles.map(p=>p.group))];
 if(groups.length>1)return {status:'conflict',reason:'MULTIPLE_FULL_PROFILE_IDENTITIES'};
 if(!groups.length)return {status:'needs_context',reason:'FULL_PROFILE_IDENTITY_OR_SUBJECT_UNRESOLVED'};
 const profiles=eligibleProfiles.filter(p=>p.group===groups[0]),targets=[...new Set(profiles.map(p=>targetFor(p,i)).filter((v):v is string=>v!==null))];
 if(targets.length>1)return {status:'conflict',reason:'FULL_PROFILE_SUBJECT_CONFLICT'};
 const p=profiles.find(p=>targetFor(p,i)===targets[0])??profiles[0]!;
 const target=targets[0]??null,provisional=p.provisional&&!(p.id==='R01'&&hasLiteral(i.merchantText+' '+i.description,['такси','taxi']))&&!(p.id==='BEA053'&&hasLiteral(i.merchantText+' '+i.description,['эпиляция','эпиляции','восковая эпиляция','маникюр']));
 const delivery=['F58','F59','F60','F61'].includes(p.id);
 return {status:'recognized',entry:{name:p.legacyName??p.name,aliases:[...p.forms],service:'unknown',source:p.source,delivery},literal:hits.find(h=>h.value.id===p.id)!.form,target,parentOnly:p.parentOnly||target==='telecom_root',provisional,profileId:p.group};
}
