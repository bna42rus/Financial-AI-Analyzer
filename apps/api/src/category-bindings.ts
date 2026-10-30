import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {object,choice,uuid} from '../../../packages/finance-core/src/model.ts';
import {categoryTargets} from '../../../packages/finance-core/src/catalog/generated/activity-v1.ts';
import {resolveOwnCategory} from '../../../packages/finance-core/src/category-resolution.ts';
import type {BatchUndo} from './finance-exclusions.ts';
import {HttpError} from './types.ts';
export type CategoryBindingIntent={kind:'set_category_binding';id:string;targetKey:string;categoryId:string|null;subcategoryId:string|null};
export function parseCategoryBinding(input:unknown):CategoryBindingIntent{
 const r=object(input,['kind','targetKey','categoryId','subcategoryId']);if(r.kind!=='set_category_binding')throw new TypeError('INVALID_INTENT');
 const categoryId=r.categoryId===null?null:uuid(r.categoryId),subcategoryId=r.subcategoryId==null?null:uuid(r.subcategoryId);if(categoryId===null&&subcategoryId!==null)throw new TypeError('MISSING_CATEGORY');
 return {kind:'set_category_binding',id:randomUUID(),targetKey:choice(r.targetKey,categoryTargets.map(t=>t.key)),categoryId,subcategoryId};
}
export async function applyCategoryBinding(db:PoolClient,userId:string,intent:CategoryBindingIntent,graph:Graph):Promise<BatchUndo>{
 const target=categoryTargets.find(t=>t.key===intent.targetKey)!;
 if(intent.categoryId!==null){const resolution=resolveOwnCategory(intent.targetKey,graph.categories,'expense',{bindings:{[intent.targetKey]:{categoryId:intent.categoryId,subcategoryId:intent.subcategoryId}}});if(resolution.status!=='resolved')throw new HttpError(409,'CATEGORY_BINDING_INVALID');}
 const previous=(await db.query('SELECT * FROM finance.category_binding WHERE user_id=$1 AND target_key=$2',[userId,intent.targetKey])).rows[0];
 if(intent.categoryId===null)await db.query('DELETE FROM finance.category_binding WHERE user_id=$1 AND target_key=$2',[userId,intent.targetKey]);
 else await db.query(`INSERT INTO finance.category_binding(user_id,id,target_key,category_id,subcategory_id) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(user_id,target_key) DO UPDATE SET category_id=EXCLUDED.category_id,subcategory_id=EXCLUDED.subcategory_id,revision=finance.category_binding.revision+1`,[userId,previous?.id??intent.id,intent.targetKey,intent.categoryId,intent.subcategoryId]);
 return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind,targetLabel:target.path.join(' / ')||target.labels[0],categoryId:intent.categoryId,subcategoryId:intent.subcategoryId,removed:intent.categoryId===null,sourceFactsPreserved:true,financialRolesUnchanged:true,financialOperationsDeleted:0}};
}
