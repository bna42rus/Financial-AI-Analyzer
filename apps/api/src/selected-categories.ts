import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {object,choice} from '../../../packages/finance-core/src/model.ts';
import {planSelectedCategories,selectedCategoryDefinitions} from '../../../packages/finance-core/src/selected-categories.ts';
import type {SelectedCategoryKey,SelectedCategoryIds} from '../../../packages/finance-core/src/selected-categories.ts';
import type {BatchUndo} from './finance-exclusions.ts';
export type SelectedCategoryIntent={kind:'add_catalog_categories';id:string;keys:SelectedCategoryKey[];ids:SelectedCategoryIds};
export function parseSelectedCategories(value:unknown):SelectedCategoryIntent{
 const r=object(value,['kind','keys']);if(r.kind!=='add_catalog_categories'||!Array.isArray(r.keys)||!r.keys.length||r.keys.length>6)throw new TypeError('INVALID_CATALOG_SELECTION');
 const keys=r.keys.map(k=>choice(k,selectedCategoryDefinitions.map(d=>d.key)));if(new Set(keys).size!==keys.length)throw new TypeError('DUPLICATE_CATALOG_SELECTION');
 return {kind:'add_catalog_categories',id:randomUUID(),keys,ids:Object.fromEntries(keys.map(key=>[key,{rootId:randomUUID(),leafId:randomUUID()}]))};
}
/** Called only inside the ordinary authorized preview/commit transaction and
 * workspace lock. Canonical IDs are allocated once during preview parsing. */
export async function applySelectedCategories(db:PoolClient,userId:string,intent:SelectedCategoryIntent,graph:Graph):Promise<BatchUndo>{
 const plan=planSelectedCategories(graph.categories,intent.keys,intent.ids);
 for(const c of plan.created)await db.query('INSERT INTO finance.category(user_id,id,name,parent_id,role,hidden) VALUES($1,$2,$3,$4,$5,$6)',[userId,c.id,c.name,c.parentId,c.role,c.hidden]);
 return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind,createdCategories:plan.created,categoryDecisions:plan.decisions,sourceFactsPreserved:true,financialRolesUnchanged:true,financialOperationsDeleted:0}};
}
