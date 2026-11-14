import type {Category,Role} from './model.ts';
import {categoryTargets} from './catalog/generated/activity-v1.ts';
import type {CategoryTarget} from './catalog/generated/activity-v1.ts';
import {catalogFold} from './catalog-lexical.ts';
const rootAliases:Readonly<Record<string,readonly string[]>>={
 'Продукты':['Продукты','Продуктовые магазины'], 'Еда вне дома':['Еда вне дома','Кафе и рестораны','Рестораны и кафе','Общепит'],
 'Жильё и дом':['Жильё и дом','Дом','Жильё'],'Транспорт':['Транспорт','Автомобиль','Авто'],
 'Здоровье и спорт':['Здоровье и спорт','Здоровье','Медицина','Спорт'],'Питомцы':['Питомцы','Домашние животные','Животные'],
 'Одежда и аксессуары':['Одежда и аксессуары','Одежда'],'Красота и уход':['Красота и уход','Красота'],
 'Связь и интернет':['Связь и интернет','Связь'],'Подписки и цифровые сервисы':['Подписки и цифровые сервисы','Цифровые сервисы','Подписки'],
 'Развлечения и хобби':['Развлечения и хобби','Развлечения'],'Образование':['Образование','Учёба'],
 'Путешествия':['Путешествия','Поездки'],'Подарки и благотворительность':['Подарки и благотворительность','Подарки'],
 'Семья и дети':['Семья и дети','Дети'],'Банковские услуги':['Банковские услуги','Банк'],
 'Налоги и обязательные платежи':['Налоги и обязательные платежи','Налоги'],'Работа и бизнес':['Работа и бизнес','Работа','Бизнес'],
};
const genericLeaf=new Set(['Магазины','Уход','Прочие расходы','Обслуживание','Уведомления','Комиссии'].map(catalogFold));
const targets=new Map(categoryTargets.map(t=>[t.key,t]));
export type CategoryResolution={status:'resolved';categoryId:string;subcategoryId:string|null;precision:'specific'|'parent'}|{status:'missing'|'ambiguous'|'invalid_binding';reason:string};
export type CategoryBindings=Readonly<Record<string,{categoryId:string;subcategoryId:string|null}>>;
/** All IDs come from the supplied owner's graph. No creation, resurrection,
 * fuzzy category matching, first candidate or sibling substitution. */
export function resolveOwnCategory(key:string,categories:readonly Category[],role:Role='expense',options:{bindings?:CategoryBindings;parentOnly?:boolean;target?:CategoryTarget}={}):CategoryResolution{
 if(role!=='expense'&&role!=='income')return {status:'missing',reason:'ROLE_NOT_CATEGORIZABLE'};
 if(new Set(categories.map(c=>c.id)).size!==categories.length)return {status:'ambiguous',reason:'DUPLICATE_CATEGORY_ID'};
 const byId=new Map(categories.map(c=>[c.id,c]));
 const compatible=(c:Category)=>!c.hidden&&(c.role==='both'||c.role===role);
 const valid=(c:Category)=>compatible(c)&&(c.parentId===null||!!byId.get(c.parentId)&&compatible(byId.get(c.parentId)!)&&byId.get(c.parentId)!.parentId===null);
 const pair=(c:Category):CategoryResolution=>({status:'resolved',categoryId:c.parentId??c.id,subcategoryId:c.parentId?c.id:null,precision:'specific'});
 const binding=options.bindings?.[key];if(binding){const root=byId.get(binding.categoryId),leaf=binding.subcategoryId?byId.get(binding.subcategoryId):null;
  return !root||!valid(root)||root.parentId!==null||binding.subcategoryId&&(!leaf||!valid(leaf)||leaf.parentId!==root.id)?{status:'invalid_binding',reason:'OWN_BINDING_CHANGED'}:pair(leaf??root);
 }
 const target=options.target??targets.get(key);if(!target)return {status:'missing',reason:'UNKNOWN_CATEGORY_TARGET'};
 const rootName=target.path[0],leafName=target.path[1];
 // A narrow root name is not a synonym of its entire mixed domain.
 const aliases=rootName?(rootAliases[rootName]??[rootName]).filter(name=>{
  if(['Авто','Автомобиль'].includes(name))return ['auto_service','fuel','parking'].includes(key);
  if(name==='Спорт')return ['fitness','sport_goods','sport_nutrition'].includes(key);
  if(name==='Подарки')return key==='gifts';
  if(name==='Налоги')return key==='tax';
  if(name==='Подписки')return key==='subscription_other';
  return true;
 }):[];
 const roots=new Set(aliases.map(catalogFold)),labels=new Set([...target.labels,...(leafName?[leafName]:[])].map(catalogFold));
 const available=categories.filter(valid),matchingRoots=available.filter(c=>c.parentId===null&&roots.has(catalogFold(c.name)));
 const found=options.parentOnly?[]:available.filter(c=>{
  const name=catalogFold(c.name);if(!labels.has(name))return false;
  if(!rootName)return c.parentId===null||catalogFold(byId.get(c.parentId)!.name)==='прочие расходы'; // Explicit private semantic node; no starter invention.
  if(!leafName)return c.parentId===null||roots.has(catalogFold(byId.get(c.parentId)!.name));
  if(c.parentId===null)return !roots.has(name)&&!genericLeaf.has(name);
  return roots.has(catalogFold(byId.get(c.parentId)!.name));
 });
 if(found.length>1)return {status:'ambiguous',reason:'MULTIPLE_COMPATIBLE_CATEGORIES'};
 if(found[0])return pair(found[0]);
 if(matchingRoots.length>1)return {status:'ambiguous',reason:'MULTIPLE_COMPATIBLE_PARENTS'};
 if(matchingRoots[0])return {status:'resolved',categoryId:matchingRoots[0].id,subcategoryId:null,precision:'parent'};
 return {status:'missing',reason:'NO_COMPATIBLE_OWN_CATEGORY'};
}
export const privateCategoryTarget=(key:string,labels:readonly string[]):CategoryTarget=>({key,path:[],labels});
