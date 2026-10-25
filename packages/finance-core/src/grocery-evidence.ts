import type {MerchantEntry} from './merchant-catalog.ts';
import {brandForms,brandKeys,brandPattern} from './merchant-aliases.ts';
const store=brandPattern(brandForms(['продукты','продуктов','магазин продуктов','магазине продуктов','супермаркет','супермаркета','супермаркете','гипермаркет','гипермаркета','гипермаркете','универсам','универсама','универсаме','гастроном','гастронома','гастрономе','дискаунтер','дискаунтера','дискаунтере','продуктовый','продуктового','продуктовом','продукты питания','grocery','supermarket','hypermarket','food store']));
// This is a veto for a food-store rule, not a new generic activity/category dictionary.
const otherActivity=brandPattern(brandForms(['кафе','кофейня','кофейни','coffee','cafe','kafe','ресторан','ресторана','ресторане','restaurant','бургерная','бургерной','burger','аптека','аптеки','аптеке','pharmacy','косметик','косметики','косметика','cosmetics','одежда','одежды','одежде','clothing','одежда для детей','детская одежда','обувь','обуви','shoes','авиакомпания','авиакомпании','авиабилет','авиабилеты','airlines','airline','airways','flight','pobeda airlines','аэропорт','аэропорта','airport','метрополитен','проезд','проезда','метро билет','metro ticket','transport','цветы','цветов','цветочный','цветочного','flowers','flower','шторы','штор','curtains','строительная лента','лента строительная','агентство','агентства','agency','отель','отеля','отеле','hotel','рекламное','рекламного','advertising','цветочного','цветочном','цветочному','цветочным','турагентство','турагентства','туристическое','туристического','travel','travel agency','строительный','строительного','строительном','строительные','клейкая','клейкой','липкая','липкой','перевод','перевода','transfer','perevod']));
const nonFoodMcc=/(?:^| )mcc (?:3[0-9]{3}|4[0-9]{3}|5(?:6[0-9]{2}|7[0-9]{2}|81[1-8]|91[0-9]|992)|6[0-9]{3}|7[0-9]{3})(?=$| )/u;
const foodMcc=/(?:^| )mcc (?:5411|5422|5441|5451|5462|5499)(?=$| )/u;
const specificStores:Record<string,RegExp>={
 METRO:brandPattern(brandForms(['metro cash carry','metro cash and carry','metro cc','метро кэш энд керри'])),
 'Глобус':brandPattern(brandForms(['гиперглобус','hyperglobus'])),
 'ДА!':brandPattern(brandForms(['market da','да маркет'])),
 'В1 — Первый выбор':brandPattern(brandForms(['первый выбор','первого выбора','первому выбору','первым выбором','первом выборе']))
};
/** A homonymous word alone is insufficient. Both merchant and sanitized description
 * can veto assignment, while source facts, amounts and identity hashes remain untouched. */
export function groceryEvidence(entry:MerchantEntry,merchant:string,description:string,context:{mcc?:string|null;bankCategory?:string}={},fromDescription=false):boolean{
 const keys=brandKeys(merchant+' '+description);
 const mcc=context.mcc&&/^\d{4}$/u.test(context.mcc)?'mcc '+context.mcc:'';
 if(keys.some(k=>otherActivity.test(k)||nonFoodMcc.test(k))||nonFoodMcc.test(mcc)||brandKeys(context.bankCategory??'').some(k=>otherActivity.test(k)))return false;
 if(!entry.requireGroceryContext)return true;
 if(fromDescription){
  const alias=brandPattern(entry.aliases),before=new RegExp(store.source+'$','u'),after=new RegExp('^(?:'+store.source+')','u');
  return keys.some(k=>{if(specificStores[entry.name]?.test(k))return true;const match=alias.exec(k);return !!match&&(before.test(k.slice(0,match.index).trim())||after.test(k.slice(match.index+match[0].length).trim()));});
 }
 return foodMcc.test(mcc)||keys.some(k=>store.test(k)||foodMcc.test(k)||specificStores[entry.name]?.test(k))||brandKeys(context.bankCategory??'').some(k=>store.test(k));
}
