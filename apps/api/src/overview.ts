import {financialTimezone} from './finance-profile.ts';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {parseOverviewView,parseWidget,calculateOverview,defaultOverview} from '../../../packages/finance-core/src/overview.ts';
import type {OverviewView} from '../../../packages/finance-core/src/overview.ts';
import {parseOperationsFilter} from '../../../packages/finance-core/src/operations.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';
import {operationsDataset,assertReferences} from './operations.ts';
import {budgetRows} from './budgets.ts';
import {HttpError} from './types.ts';
export type OverviewIntent={kind:'save_overview_view';id:string;name:string;definition:OverviewView;isDefault:boolean;create:boolean}|{kind:'delete_overview_view';id:string}|{kind:'reorder_overview_views';id:string;viewIds:string[]};
export function parseOverviewIntent(value:unknown):OverviewIntent{
 const r=object(value,['kind','id','name','definition','isDefault','create','viewIds']),id=r.id===undefined?randomUUID():uuid(r.id);
 if(r.kind==='delete_overview_view'){object(value,['kind','id']);if(r.id===undefined)throw new TypeError('MISSING_ID');return {kind:r.kind,id};}
 if(r.kind==='reorder_overview_views'){object(value,['kind','viewIds']);if(!Array.isArray(r.viewIds)||!r.viewIds.length||r.viewIds.length>100)throw new TypeError('INVALID_VIEWS');const viewIds=r.viewIds.map(uuid);if(new Set(viewIds).size!==viewIds.length)throw new TypeError('DUPLICATE_VIEWS');return {kind:r.kind,id,viewIds};}
 object(value,['kind','id','name','definition','isDefault','create']);if(r.kind!=='save_overview_view'||typeof r.isDefault!=='boolean'||typeof r.create!=='boolean'||!r.create&&r.id===undefined)throw new TypeError('INVALID_VIEW');const name=safeText(r.name,160).trim();if(!name)throw new TypeError('EMPTY_NAME');return {kind:r.kind,id,name,definition:parseOverviewView(r.definition),isDefault:r.isDefault,create:r.create};
}
export async function overviewViews(db:PoolClient,userId:string){return {views:(await db.query('SELECT id,name,definition,is_default AS "isDefault",dependency_status AS "dependencyStatus",revision,position,modified_at AS "modifiedAt" FROM finance.overview_view WHERE user_id=$1 ORDER BY position,name,id',[userId])).rows};}
export async function assertOverviewReferences(db:PoolClient,userId:string,definition:OverviewView){await assertReferences(db,userId,definition.filter);for(const w of definition.widgets){await assertReferences(db,userId,{...w.filter,...(w.excludedCategoryIds.length?{excludedCategoryIds:w.excludedCategoryIds}:{})});if(w.budgetIds.length&&(await db.query('SELECT id FROM finance.budget WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,w.budgetIds])).rowCount!==w.budgetIds.length)throw new HttpError(409,'VIEW_DEPENDENCY_CHANGED');}}
export async function applyOverviewIntent(db:PoolClient,userId:string,intent:OverviewIntent){
 if(intent.kind==='reorder_overview_views'){const {views}=await overviewViews(db,userId);if(views.length!==intent.viewIds.length||views.some(v=>!intent.viewIds.includes(v.id)))throw new HttpError(409,'VIEW_DEPENDENCY_CHANGED');await db.query('UPDATE finance.overview_view v SET position=o.position-1 FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id,position) WHERE v.user_id=$1 AND v.id=o.id',[userId,intent.viewIds]);return {table:'batch' as const,id:intent.id,before:null,details:{kind:intent.kind,views:intent.viewIds.length,operationsChanged:0}};}
 if(intent.kind==='delete_overview_view'){if(!(await db.query('DELETE FROM finance.overview_view WHERE user_id=$1 AND id=$2 RETURNING id',[userId,intent.id])).rowCount)throw new HttpError(404,'NOT_FOUND');return {table:'batch' as const,id:intent.id,before:null,details:{kind:intent.kind,viewId:intent.id,operationsDeleted:0}};}
 const folded=(name:string)=>name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('ru');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['overview-name:'+userId]);
 const names=(await db.query<{id:string;name:string}>('SELECT id,name FROM finance.overview_view WHERE user_id=$1',[userId])).rows;
 if((intent.create||names.find(v=>v.id===intent.id)?.name!==intent.name)&&names.some(v=>v.id!==intent.id&&folded(v.name)===folded(intent.name)))throw new HttpError(409,'OVERVIEW_VIEW_NAME_EXISTS');
 if(intent.create&&Number((await db.query('SELECT count(*) AS n FROM finance.overview_view WHERE user_id=$1',[userId])).rows[0].n)>=100)throw new HttpError(409,'VIEW_LIMIT');await assertOverviewReferences(db,userId,intent.definition);
 if(intent.isDefault)await db.query('UPDATE finance.overview_view SET is_default=false WHERE user_id=$1 AND id<>$2',[userId,intent.id]);
 if(intent.create)await db.query('INSERT INTO finance.overview_view(user_id,id,name,definition,is_default,position) VALUES($1,$2,$3,$4,$5,(SELECT count(*) FROM finance.overview_view WHERE user_id=$1))',[userId,intent.id,intent.name,JSON.stringify(intent.definition),intent.isDefault]);
 else if(!(await db.query("UPDATE finance.overview_view SET name=$3,definition=$4,is_default=$5,dependency_status='ready' WHERE user_id=$1 AND id=$2 RETURNING id",[userId,intent.id,intent.name,JSON.stringify(intent.definition),intent.isDefault])).rowCount)throw new HttpError(404,'NOT_FOUND');
 return {table:'batch' as const,id:intent.id,before:null,details:{kind:intent.kind,viewId:intent.id,name:intent.name,isDefault:intent.isDefault,widgets:intent.definition.widgets.length,operationsChanged:0}};
}
export async function queryOverview(db:PoolClient,userId:string,value:unknown){
 const r=object(value??{},['filter','widgets']),filter=parseOperationsFilter(r.filter??{});if(filter.metric)throw new TypeError('METRIC_FILTER_CONFLICT');const items=r.widgets??defaultOverview().widgets;if(!Array.isArray(items)||items.length>30)throw new TypeError('INVALID_WIDGETS');const widgets=items.map(parseWidget);if(new Set(widgets.map(w=>w.id)).size!==widgets.length)throw new TypeError('DUPLICATE_WIDGETS');
 const {state,operations}=await operationsDataset(db,userId),chosenTimezone=await financialTimezone(db,userId),timezone=chosenTimezone??'Etc/UTC',now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 const budgets=await budgetRows(db,userId);return {generation:state.generation,revision:state.revision,timezone,profileTimezoneMissing:chosenTimezone===null,warnings:[...(chosenTimezone===null?['Часовой пояс профиля ещё не выбран. Относительные периоды показаны по UTC; выберите свой часовой пояс в настройках.']:[]),...(operations.some(o=>o.reviewReasons.includes('incomplete_credit_data'))?['Для части кредитных операций не хватает детализации. Проверьте выписки кредитной карты и состав платежей.']:[])],budgetOptions:budgets.map(b=>({id:b.id,name:b.name})),...calculateOverview(operations,{...state,budgets},filter,widgets,now,timezone)};
}
