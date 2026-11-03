import {categoryTargets} from './catalog/generated/activity-v1.ts';
import type {Category} from './model.ts';
import {catalogFold} from './catalog-lexical.ts';
import {resolveOwnCategory} from './category-resolution.ts';
const selectedKeys=['powerbank','sport_nutrition','electronics','dentistry','optics','medical_devices'] as const;
export type SelectedCategoryKey=typeof selectedKeys[number];
export const selectedCategoryDefinitions=selectedKeys.map(key=>{const target=categoryTargets.find(t=>t.key===key)!;return {key,path:target.path,labels:target.labels};});
export type SelectedCategoryIds=Readonly<Record<string,{rootId:string;leafId:string}>>;
export type CategoryAddition={key:SelectedCategoryKey;label:string;status:'present'|'create'|'hidden'|'ambiguous';categoryId?:string;subcategoryId?:string|null;reason?:string};
const roots:Readonly<Record<string,readonly string[]>>={'Связь и интернет':['Связь и интернет','Связь'],'Здоровье и спорт':['Здоровье и спорт','Здоровье','Медицина'],'Техника и электроника':['Техника и электроника','Электроника','Техника']};
/** Pure preview. Only the supplied owner's categories are examined. Nothing
 * is added on entry/classification, unhidden or given an old deleted ID. */
export function planSelectedCategories(categories:readonly Category[],keys:readonly SelectedCategoryKey[],ids:SelectedCategoryIds){
 if(new Set(categories.map(c=>c.id)).size!==categories.length)throw new TypeError('DUPLICATE_CATEGORY_ID');
 const current=[...categories],created:Category[]=[],decisions:CategoryAddition[]=[];
 for(const d of selectedCategoryDefinitions.filter(d=>keys.includes(d.key))){
  const label=d.path.join(' / '),aliases=[...(roots[d.path[0]!]??[d.path[0]!]),...(d.key==='sport_nutrition'?['Спорт']:[])],same=(a:string,b:string)=>catalogFold(a)===catalogFold(b);
  const hidden=current.some(c=>(c.role==='expense'||c.role==='both')&&c.hidden&&(d.labels.some(n=>same(n,c.name))||c.parentId===null&&aliases.some(n=>same(n,c.name))));
  const resolution=resolveOwnCategory(d.key,current,'expense',{target:{key:d.key,path:[...d.path],labels:[...d.labels,...(d.path.length===1?aliases:[])]}});
  if(resolution.status==='ambiguous'||resolution.status==='invalid_binding'){decisions.push({key:d.key,label,status:'ambiguous',reason:resolution.reason});continue;}
  if(resolution.status==='resolved'&&(resolution.precision==='specific'||d.path.length===1)){decisions.push({key:d.key,label,status:'present',categoryId:resolution.categoryId,subcategoryId:resolution.subcategoryId});continue;}
  if(hidden){decisions.push({key:d.key,label,status:'hidden',reason:'OWN_CATEGORY_HIDDEN'});continue;}
  const pool=ids[d.key];if(!pool)throw new TypeError('MISSING_CATEGORY_ALLOCATION');
  let parent=resolution.status==='resolved'?current.find(c=>c.id===resolution.categoryId):undefined;
  if(!parent){parent={id:pool.rootId,name:d.path[0]!,parentId:null,role:'expense',hidden:false};current.push(parent);created.push(parent);}
  let leaf:Category|undefined;
  if(d.path.length>1){leaf={id:pool.leafId,name:d.path[1]!,parentId:parent.id,role:'expense',hidden:false};current.push(leaf);created.push(leaf);}
  decisions.push({key:d.key,label,status:'create',categoryId:parent.id,subcategoryId:leaf?.id??null});
 }
 if(new Set(current.map(c=>c.id)).size!==current.length)throw new TypeError('DUPLICATE_CATEGORY_ID');
 return {created,decisions};
}
export function selectedCategoryOptions(categories:readonly Category[]){return planSelectedCategories(categories,selectedCategoryDefinitions.map(d=>d.key),Object.fromEntries(selectedCategoryDefinitions.map(d=>[d.key,{rootId:'preview-root:'+d.key,leafId:'preview-leaf:'+d.key}]))).decisions;}
