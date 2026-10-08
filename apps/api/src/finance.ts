import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {drizzle,eq} from '../../../packages/database/src/finance.ts';
import * as tables from '../../../packages/database/src/finance.ts';
import {object,choice,uuid,dateFact,correction,initialSemantics,defaultRole,facet,kinds,linkKinds} from '../../../packages/finance-core/src/model.ts';
import type {Graph,BankFact,Kind,Component,Link,Semantics,Operation} from '../../../packages/finance-core/src/model.ts';
import {parsePersistedMinor} from '../../../packages/finance-core/src/money.ts';
import {reconcile,aggregate} from '../../../packages/finance-core/src/graph.ts';
import type {Filter} from '../../../packages/finance-core/src/graph.ts';
import {starterCategories} from '../../../packages/finance-core/src/starter.ts';
import {applyRules,validateRule} from '../../../packages/finance-core/src/rules.ts';
import type {Rule} from '../../../packages/finance-core/src/rules.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';
import {HttpError} from './types.ts';

const bool=(v:unknown)=>{if(typeof v!=='boolean')throw new TypeError('INVALID_BOOLEAN');return v;};
const ref=(v:unknown)=>v===null?null:uuid(v);
function stable(value:unknown):string {return JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
function revision(v:unknown){if(typeof v!=='string'||!/^(0|[1-9]\d*)$/.test(v))throw new TypeError('INVALID_REVISION');return v;}
export async function prepareFinance(db:PoolClient,userId:string){
 await db.query("SELECT set_config('app.user_id',$1,true)",[userId]);
 // Stable lock order shared with access mutations. No entitlement can change during this stage.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-cycle:'+userId]);
 const state=(await db.query(`SELECT u.email_verified,s.status,CASE WHEN c.user_id IS NOT NULL THEN c.indefinite ELSE s.indefinite END AS indefinite,
 CASE WHEN c.user_id IS NOT NULL THEN c.access_end ELSE s.access_end END AS access_end,clock_timestamp() AS now
 FROM identity.auth_user u JOIN identity.security_state s ON s.user_id=u.id LEFT JOIN commerce.access_cycle c ON c.user_id=u.id WHERE u.id=$1 FOR SHARE OF u,s`,[userId])).rows[0];
 if(!state?.email_verified||state.status!=='active'||!state.indefinite&&!(state.access_end>state.now))throw new HttpError(403,'FINANCE_ACCESS_REQUIRED');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['finance-workspace:'+userId]);
 const created=await db.query('INSERT INTO finance.workspace(user_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING generation',[userId]);
 if(created.rowCount)for(const role of ['expense','income']as const)for(const names of starterCategories[role]){
  const parent=randomUUID();await db.query('INSERT INTO finance.category(user_id,id,name,role) VALUES($1,$2,$3,$4)',[userId,parent,names[0],role]);
  for(const name of names.slice(1))await db.query('INSERT INTO finance.category(user_id,id,parent_id,name,role) VALUES($1,$2,$3,$4,$5)',[userId,randomUUID(),parent,name,role]);
 }
 return (await db.query('SELECT * FROM finance.workspace WHERE user_id=$1 FOR UPDATE',[userId])).rows[0] as {generation:string;revision:string;loan_mode:'cashflow'|'economic'};
}
export async function loadFinance(db:PoolClient,userId:string){
 const count=(await db.query('SELECT count(*) AS n FROM finance.transaction WHERE user_id=$1',[userId])).rows[0].n;
 if(BigInt(count)>10000n)throw new HttpError(409,'FINANCE_SIZE_LIMIT');
 const orm=drizzle(db),a=await orm.select().from(tables.accounts).where(eq(tables.accounts.userId,userId)),c=await orm.select().from(tables.categories).where(eq(tables.categories.userId,userId)),t=await orm.select().from(tables.transactions).where(eq(tables.transactions.userId,userId)),o=await orm.select().from(tables.observations).where(eq(tables.observations.userId,userId)),p=await orm.select().from(tables.components).where(eq(tables.components.userId,userId)),l=await orm.select().from(tables.links).where(eq(tables.links.userId,userId));
 const observations=new Map(o.map(r=>[r.id,r])),state=(await db.query('SELECT generation,revision,loan_mode FROM finance.workspace WHERE user_id=$1',[userId])).rows[0];
 const graph:Graph={accounts:a.map(({userId,revision,systemName,...r})=>r),categories:c.map(({userId,revision,...r})=>r),operations:t.map(r=>{
  const source=observations.get(r.sourceObservationId);if(!source)throw new TypeError('SOURCE_MISSING');
  const {userId,id,transactionId,...fact}=source;return {id:r.id,source:{...fact,amountMinor:fact.amountMinor.toString(),operationAmountMinor:fact.operationAmountMinor?.toString()??null},corrections:r.corrections,semantics:r.semantics,comment:r.comment,analyticsOverride:r.analyticsOverride,decomposition:r.decomposition,reviewReasons:r.reviewReasons};
 }),components:p.filter(r=>r.active).map(({userId,active,...r})=>({...r,amountMinor:r.amountMinor.toString()})),links:l.map(({userId,revision,...r})=>({...r,amountMinor:r.amountMinor.toString()})),loanMode:state.loan_mode};
 return {graph,state,parties:(await orm.select().from(tables.counterparties).where(eq(tables.counterparties.userId,userId))).map(({userId,revision,...r})=>({...r,revision:revision.toString()})),rules:(await db.query('SELECT id,name,enabled,priority,conditions,assignments,revision FROM finance.rule WHERE user_id=$1 ORDER BY id',[userId])).rows as (Rule&{revision:string})[]};
}
export async function financeView(db:PoolClient,userId:string,filter:Filter={}){
 const {graph,state,parties,rules}=await loadFinance(db,userId),projection=reconcile(graph);
 return {generation:state.generation,revision:state.revision,accounts:graph.accounts,categories:graph.categories,counterparties:parties,rules,operations:projection.operations.map(p=>{const o=graph.operations.find(o=>o.id===p.id)!;return {...p,classification:o.semantics,comment:o.comment};}),links:projection.links,summary:aggregate(projection.operations,filter)};
}
export function parseFilter(value:unknown):Filter{
 const r=object(value,['from','through','accountIds','categoryIds','includeExcluded']),f:Filter={};
 for(const k of ['from','through']as const)if(k in r){const date=dateFact({precision:'day',date:r[k]});f[k]=(date as {date:string}).date;}
 if(f.from&&f.through&&f.from>f.through)throw new TypeError('INVALID_RANGE');
 for(const k of ['accountIds','categoryIds']as const)if(k in r){if(!Array.isArray(r[k])||r[k].length>100)throw new TypeError('INVALID_FILTER');f[k]=(r[k]as unknown[]).map(uuid);}
 if('includeExcluded'in r)f.includeExcluded=bool(r.includeExcluded);return f;
}
export async function operationView(db:PoolClient,userId:string,id:unknown){
 const {graph}=await loadFinance(db,userId),op=graph.operations.find(o=>o.id===uuid(id));if(!op)throw new HttpError(404,'NOT_FOUND');
 const {bankRefHmac,...source}=op.source;return {...op,source,projection:reconcile(graph).operations.find(p=>p.id===op.id),components:graph.components.filter(c=>c.transactionId===op.id),links:graph.links.filter(l=>l.sourceId===op.id||l.targetId===op.id)};
}
type Intent={kind:'operation'|'components'|'link'|'account'|'category'|'counterparty'|'rule'|'analytics'|'undo';id:string;patch?:Record<string,unknown>;parts?:Component[];link?:Link;create?:boolean;value?:unknown};
export function parseIntent(value:unknown):Intent {
 const r=object(value,['kind','id','patch','parts','link','create','value']),kind=choice(r.kind,['operation','components','link','account','category','counterparty','rule','analytics','undo']as const),intent:Intent={kind,id:r.id===undefined?randomUUID():uuid(r.id)};
 const required=kind==='components'?['parts']:kind==='link'?['link']:['analytics','undo'].includes(kind)?['value']:['patch'];
 if(Object.keys(r).some(k=>!['kind','id',...required,...(['category','counterparty','rule'].includes(kind)?['create']:[])].includes(k))||required.some(k=>!(k in r)))throw new TypeError('INVALID_INTENT');
 if(['operation','components','account','undo'].includes(kind)&&r.id===undefined)throw new TypeError('MISSING_ID');
 if(kind==='operation'){
  const p=object(r.patch,['corrections','kind','role','categoryId','subcategoryId','merchant','counterpartyId','comment','analyticsOverride']),out:Record<string,unknown>={};
  if('corrections'in p)out.corrections=p.corrections===null?{}:correction(p.corrections);
  if('kind'in p)out.kind=choice(p.kind,kinds);if('role'in p)out.role=choice(p.role,['expense','income','neutral','unresolved']);
  for(const k of ['categoryId','subcategoryId','counterpartyId']as const)if(k in p)out[k]=ref(p[k]);
  for(const k of ['merchant','comment']as const)if(k in p)out[k]=safeText(p[k],k==='comment'?1000:160);
  if('analyticsOverride'in p)out.analyticsOverride=choice(p.analyticsOverride,['default','include','exclude']);intent.patch=out;
 }else if(kind==='components'){
  if(!Array.isArray(r.parts)||r.parts.length<1||r.parts.length>50)throw new TypeError('INVALID_COMPONENTS');
  intent.parts=r.parts.map(v=>{const p=object(v,['id','type','amountMinor','role','categoryId','subcategoryId']);parsePersistedMinor(p.amountMinor);return {id:p.id===undefined?randomUUID():uuid(p.id),transactionId:intent.id,type:choice(p.type,['principal','interest','fee','insurance','other']),amountMinor:p.amountMinor as string,role:p.role===undefined?facet('unresolved'):facet(choice(p.role,['expense','income','neutral','unresolved']),'user',true),category:p.categoryId===undefined?facet(null):facet(ref(p.categoryId),'user',true),subcategory:p.subcategoryId===undefined?facet(null):facet(ref(p.subcategoryId),'user',true)};});
  if(new Set(intent.parts.map(p=>p.id)).size!==intent.parts.length)throw new TypeError('DUPLICATE_COMPONENT');
 }else if(kind==='link'){
  const p=object(r.link,['sourceId','targetId','sourceComponentId','targetComponentId','kind','amountMinor','status']);if(parsePersistedMinor(p.amountMinor)<=0n)throw new TypeError('INVALID_ALLOCATION');
  intent.link={id:intent.id,sourceId:uuid(p.sourceId),targetId:uuid(p.targetId),sourceComponentId:p.sourceComponentId===undefined?null:ref(p.sourceComponentId),targetComponentId:p.targetComponentId===undefined?null:ref(p.targetComponentId),kind:choice(p.kind,linkKinds),amountMinor:p.amountMinor as string,status:choice(p.status,['candidate','confirmed','rejected']),confidence:100,createdBy:'user'};
 }else if(kind==='account'){
  const p=object(r.patch,['name','type','analyticsEnabled','defaultVisible','loanMode']),out:Record<string,unknown>={};if('name'in p)out.name=safeText(p.name,160);
  if('type'in p)out.type=choice(p.type,['debit_card','credit_card','bank_account','loan','savings','deposit','other']);for(const k of ['analyticsEnabled','defaultVisible']as const)if(k in p)out[k]=bool(p[k]);
  if('loanMode'in p)out.loanMode=p.loanMode===null?null:choice(p.loanMode,['cashflow','economic']);intent.patch=out;
 }else if(kind==='category'){
  const p=object(r.patch,['name','role','parentId','hidden']),out:Record<string,unknown>={};if('name'in p)out.name=safeText(p.name,160);if('role'in p)out.role=choice(p.role,['expense','income','both']);if('parentId'in p)out.parentId=ref(p.parentId);if('hidden'in p)out.hidden=bool(p.hidden);intent.patch=out;intent.create=r.create===undefined?false:bool(r.create);
 }else if(kind==='counterparty'){
  const p=object(r.patch,['name','state','isSelf']),out:Record<string,unknown>={};if('name'in p)out.name=safeText(p.name,160);if('state'in p)out.state=choice(p.state,['registered','ignored']);if('isSelf'in p)out.isSelf=bool(p.isSelf);intent.patch=out;intent.create=r.create===undefined?false:bool(r.create);
 }else if(kind==='rule'){intent.patch=validateRule(r.patch) as unknown as Record<string,unknown>;intent.create=r.create===undefined?false:bool(r.create);
 }else if(kind==='analytics')intent.value=choice(r.value,['cashflow','economic']);else intent.value=uuid(r.value);
 if(intent.patch&&Object.keys(intent.patch).length===0)throw new TypeError('EMPTY_PATCH');
 if(intent.patch&&'name'in intent.patch&&!intent.patch.name)throw new TypeError('EMPTY_NAME');
 if(['category','counterparty','rule'].includes(kind)&&!intent.create&&r.id===undefined)throw new TypeError('MISSING_ID');return intent;
}
const columns={transaction:['corrections','semantics','comment','analytics_override','decomposition','review_reasons'],account:['display_name','account_type','analytics_enabled','default_visible','loan_mode'],category:['name','role','parent_id','hidden'],counterparty:['name','state','is_self'],rule:['name','enabled','priority','conditions','assignments'],link:['source_id','target_id','source_component_id','target_component_id','kind','amount_minor','status','confidence','created_by']}as const;
type Undo={table:keyof typeof columns|'components'|'workspace';id:string;before:Record<string,unknown>|Record<string,unknown>[]|null};
const jsonColumns=new Set(['corrections','semantics','review_reasons','conditions','assignments','role','category','subcategory']);
async function update(db:PoolClient,userId:string,table:keyof typeof columns,id:string,values:Record<string,unknown>){
 const keys=Object.keys(values);if(!keys.length||keys.some(k=>!(columns[table]as readonly string[]).includes(k)))throw new TypeError('INVALID_INTERNAL_PATCH');
 const params=keys.map(k=>jsonColumns.has(k)?JSON.stringify(values[k]):values[k]);await db.query(`UPDATE finance.${table} SET ${keys.map((k,i)=>k+'=$'+(i+3)).join(',')},revision=revision+1 WHERE user_id=$1 AND id=$2`,[userId,id,...params]);
}
async function row(db:PoolClient,userId:string,table:keyof typeof columns,id:string){const r=(await db.query(`SELECT * FROM finance.${table} WHERE user_id=$1 AND id=$2`,[userId,id])).rows[0];if(!r)throw new HttpError(404,'NOT_FOUND');return r;}
function ownRefs(graph:Graph,parties:{id:string}[],p:Record<string,unknown>){
 for(const [key,items]of [['accountId',graph.accounts],['categoryId',graph.categories],['subcategoryId',graph.categories],['counterpartyId',parties]]as const)if(p[key]!==undefined&&p[key]!==null&&!items.some(i=>i.id===p[key]))throw new HttpError(404,'NOT_FOUND');
}
function categoryCompatible(graph:Graph,role:string,categoryId:string|null,subcategoryId:string|null){
 const category=graph.categories.find(c=>c.id===categoryId),sub=graph.categories.find(c=>c.id===subcategoryId),allows=(r:string)=>!['expense','income'].includes(role)||r==='both'||r===role;
 if(category&&(category.parentId!==null||!allows(category.role))||sub&&(sub.parentId!==category?.id||!allows(sub.role)))throw new HttpError(409,'CATEGORY_ROLE_CONFLICT');
}
async function apply(db:PoolClient,userId:string,intent:Intent,currentRevision:string):Promise<Undo> {
 const {graph,parties}=await loadFinance(db,userId),p=intent.patch??{},id=intent.id;
 if(intent.kind==='operation'){
  const before=await row(db,userId,'transaction',id),semantics:Semantics=structuredClone(before.semantics),values:Record<string,unknown>={};ownRefs(graph,parties,p);
  if(p.corrections!==undefined){ownRefs(graph,parties,p.corrections as Record<string,unknown>);values.corrections=p.corrections;}
  const map={kind:'kind',role:'role',categoryId:'category',subcategoryId:'subcategory',merchant:'merchant',counterpartyId:'counterparty'}as const;
  for(const [input,key]of Object.entries(map))if(input in p)(semantics as unknown as Record<string,unknown>)[key]=facet(p[input],'user',true);
  categoryCompatible(graph,semantics.role.value,semantics.category.value,semantics.subcategory.value);
  values.semantics=semantics;if('comment'in p)values.comment=p.comment;if('analyticsOverride'in p)values.analytics_override=p.analyticsOverride;
  const cleared=new Set<string>();if('kind'in p)cleared.add('low_kind_confidence');if('role'in p)for(const r of ['low_role_confidence','unresolved_role','unresolved_transfer'])cleared.add(r);if('categoryId'in p||'subcategoryId'in p)cleared.add('low_category_confidence');
  values.review_reasons=before.review_reasons.filter((r:string)=>!cleared.has(r));await update(db,userId,'transaction',id,values);return {table:'transaction',id,before:Object.fromEntries(columns.transaction.map(k=>[k,before[k]]))};
 }
 if(intent.kind==='components'){
  await row(db,userId,'transaction',id);const before=(await db.query('SELECT * FROM finance.component WHERE user_id=$1 AND transaction_id=$2 ORDER BY id',[userId,id])).rows;
  for(const part of intent.parts!){
   ownRefs(graph,parties,{categoryId:part.category.value,subcategoryId:part.subcategory.value});
   categoryCompatible(graph,part.role.value,part.category.value,part.subcategory.value);
   const existing=(await db.query('SELECT transaction_id FROM finance.component WHERE user_id=$1 AND id=$2',[userId,part.id])).rows[0];if(existing&&existing.transaction_id!==id)throw new HttpError(404,'NOT_FOUND');
  }
  const sum=intent.parts!.reduce((s,p)=>s+BigInt(p.amountMinor),0n),op=graph.operations.find(o=>o.id===id)!;
  if(sum!==BigInt(op.corrections.amountMinor??op.source.amountMinor))throw new HttpError(409,'COMPONENT_SUM_CONFLICT');
  await db.query('UPDATE finance.component SET active=false WHERE user_id=$1 AND transaction_id=$2',[userId,id]);
  for(const part of intent.parts!)await db.query(`INSERT INTO finance.component(user_id,id,transaction_id,type,amount_minor,role,category,subcategory) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT(user_id,id) DO UPDATE SET type=EXCLUDED.type,amount_minor=EXCLUDED.amount_minor,role=EXCLUDED.role,category=EXCLUDED.category,subcategory=EXCLUDED.subcategory,active=true`,[userId,part.id,id,part.type,part.amountMinor,JSON.stringify(part.role),JSON.stringify(part.category),JSON.stringify(part.subcategory)]);
  await update(db,userId,'transaction',id,{decomposition:true});return {table:'components',id,before:[...before,{decomposition:op.decomposition}]};
 }
 if(intent.kind==='link'){
  const l=intent.link!;if(!graph.operations.some(o=>o.id===l.sourceId)||!graph.operations.some(o=>o.id===l.targetId))throw new HttpError(404,'NOT_FOUND');
  const before=(await db.query('SELECT * FROM finance.link WHERE user_id=$1 AND id=$2',[userId,id])).rows[0]??null;
  const values={source_id:l.sourceId,target_id:l.targetId,source_component_id:l.sourceComponentId,target_component_id:l.targetComponentId,kind:l.kind,amount_minor:l.amountMinor,status:l.status,confidence:l.confidence,created_by:l.createdBy};
  if(before)await update(db,userId,'link',id,values);else await db.query(`INSERT INTO finance.link(user_id,id,source_id,target_id,source_component_id,target_component_id,kind,amount_minor,status,confidence,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[userId,id,...Object.values(values)]);
  const outcome=reconcile((await loadFinance(db,userId)).graph).links.find(x=>x.id===id);if(l.status==='confirmed'&&!outcome?.active)throw new HttpError(409,outcome?.reason??'LINK_CONFLICT');
  return {table:'link',id,before};
 }
 if(intent.kind==='analytics'){const before={loan_mode:graph.loanMode};await db.query('UPDATE finance.workspace SET loan_mode=$2 WHERE user_id=$1',[userId,intent.value]);return {table:'workspace',id:userId,before};}
 if(intent.kind==='undo'){
  const original=(await db.query("SELECT *,committed_at>clock_timestamp()-interval '30 days' AS recent FROM finance.action WHERE user_id=$1 AND id=$2",[userId,intent.value])).rows[0];
  if(!original||original.status!=='committed'||original.undone||!original.recent||original.intent.canonical.kind==='undo'||original.committed_revision!==currentRevision)throw new HttpError(409,'UNDO_CONFLICT');
  await restore(db,userId,original.undo_patch);await db.query('UPDATE finance.action SET undone=true WHERE user_id=$1 AND id=$2',[userId,intent.value]);return {table:'workspace',id:userId,before:null};
 }
 const table=intent.kind,before=intent.create?null:await row(db,userId,table,id),values:Record<string,unknown>={};
 if(table==='account'){for(const [input,key]of Object.entries({name:'display_name',type:'account_type',analyticsEnabled:'analytics_enabled',defaultVisible:'default_visible',loanMode:'loan_mode'}))if(input in p)values[key]=p[input];}
 if(table==='category'){
  if(p.parentId&&graph.categories.some(c=>c.parentId===id))throw new HttpError(409,'CATEGORY_PARENT_CONFLICT');
  if(!intent.create&&(('role'in p&&p.role!==before.role)||('parentId'in p&&p.parentId!==before.parent_id))&&(graph.operations.some(o=>o.semantics.category.value===id||o.semantics.subcategory.value===id)||graph.components.some(c=>c.category.value===id||c.subcategory.value===id)))throw new HttpError(409,'DEPENDENCY_MIGRATION_REQUIRED');
  const parentId=p.parentId===undefined?before?.parent_id:p.parentId,role=p.role??before?.role;
  if(parentId){const parent=graph.categories.find(c=>c.id===parentId);if(!parent||parent.parentId!==null||parent.id===id)throw new HttpError(409,'CATEGORY_PARENT_CONFLICT');if(parent.role!=='both'&&role!==parent.role)throw new HttpError(409,'CATEGORY_ROLE_CONFLICT');}
  if('role'in p&&p.role!=='both'&&graph.categories.some(c=>c.parentId===id&&c.role!==p.role))throw new HttpError(409,'DEPENDENCY_MIGRATION_REQUIRED');
  for(const [input,key]of Object.entries({name:'name',role:'role',parentId:'parent_id',hidden:'hidden'}))if(input in p)values[key]=p[input];
  if(intent.create){if(!p.name||!p.role)throw new TypeError('MISSING_CATEGORY');await db.query('INSERT INTO finance.category(user_id,id,name,role,parent_id,hidden) VALUES($1,$2,$3,$4,$5,$6)',[userId,id,p.name,p.role,p.parentId??null,p.hidden??false]);}
 }
 if(table==='counterparty'){for(const [input,key]of Object.entries({name:'name',state:'state',isSelf:'is_self'}))if(input in p)values[key]=p[input];if(intent.create){if(!p.name)throw new TypeError('MISSING_NAME');await db.query('INSERT INTO finance.counterparty(user_id,id,name,state,is_self) VALUES($1,$2,$3,$4,$5)',[userId,id,p.name,p.state??'registered',p.isSelf??false]);}}
 if(table==='rule'){
  const rule=p as unknown as Omit<Rule,'id'>;ownRefs(graph,parties,rule.conditions as Record<string,unknown>);ownRefs(graph,parties,rule.assignments as Record<string,unknown>);
  if(rule.assignments.role)categoryCompatible(graph,rule.assignments.role,rule.assignments.categoryId??null,rule.assignments.subcategoryId??null);Object.assign(values,p);
  if(intent.create)await db.query('INSERT INTO finance.rule(user_id,id,name,enabled,priority,conditions,assignments) VALUES($1,$2,$3,$4,$5,$6,$7)',[userId,id,p.name,p.enabled,p.priority,JSON.stringify(p.conditions),JSON.stringify(p.assignments)]);
 }
 if(!intent.create)await update(db,userId,table,id,values);
 return {table,id,before:before?Object.fromEntries(columns[table].map(k=>[k,before[k]])):null};
}
async function restore(db:PoolClient,userId:string,undo:Undo){
 if(undo.table==='workspace'){if(undo.before)await db.query('UPDATE finance.workspace SET loan_mode=$2 WHERE user_id=$1',[userId,(undo.before as Record<string,unknown>).loan_mode]);return;}
 if(undo.table==='components'){
  const parts=undo.before as Record<string,unknown>[],settings=parts.at(-1)!;
  await db.query('UPDATE finance.component SET active=false WHERE user_id=$1 AND transaction_id=$2',[userId,undo.id]);
  for(const part of parts.slice(0,-1))await db.query('UPDATE finance.component SET type=$3,amount_minor=$4,role=$5,category=$6,subcategory=$7,active=$8 WHERE user_id=$1 AND id=$2',[userId,part.id,part.type,part.amount_minor,JSON.stringify(part.role),JSON.stringify(part.category),JSON.stringify(part.subcategory),part.active]);
  await update(db,userId,'transaction',undo.id,{decomposition:settings.decomposition});return;
 }
 if(!(undo.table in columns))throw new TypeError('INVALID_UNDO');
 if(undo.before)await update(db,userId,undo.table,undo.id,undo.before as Record<string,unknown>);else await db.query(`DELETE FROM finance.${undo.table} WHERE user_id=$1 AND id=$2`,[userId,undo.id]);
}
function impact(before:Awaited<ReturnType<typeof financeView>>,after:Awaited<ReturnType<typeof financeView>>){
 return {before:before.summary,after:after.summary,affectedOperationIds:after.operations.filter(p=>JSON.stringify(p)!==JSON.stringify(before.operations.find(o=>o.id===p.id))).map(p=>p.id),dependencyConflicts:after.links.filter(l=>l.reason!==null),reviewOperationIds:after.operations.filter(o=>o.reviewReasons.length).map(o=>o.id)};
}
export async function previewFinance(db:PoolClient,userId:string,input:unknown){
 const r=object(input,['actionId','generation','revision','intent']),id=uuid(r.actionId),generation=uuid(r.generation),expected=revision(r.revision),state=await prepareFinance(db,userId);
 if(generation!==state.generation)throw new HttpError(409,'GENERATION_CHANGED');
 const existing=(await db.query('SELECT * FROM finance.action WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(existing){if(stable(existing.intent.request)!==stable(r.intent))throw new HttpError(409,'ACTION_REUSED');if(existing.status==='committed')return existing.result;}
 if(expected!==state.revision)throw new HttpError(409,'FINANCE_CHANGED');
 if(existing)return {status:'previewed',actionId:id,intent:existing.intent.canonical,impact:existing.preview};
 const intent=parseIntent(r.intent),before=await financeView(db,userId);let changes:ReturnType<typeof impact>;
 await db.query('SAVEPOINT finance_preview');try{await apply(db,userId,intent,state.revision);changes=impact(before,await financeView(db,userId));}finally{await db.query('ROLLBACK TO SAVEPOINT finance_preview');await db.query('RELEASE SAVEPOINT finance_preview');}
 await db.query('INSERT INTO finance.action(user_id,id,generation,expected_revision,intent,preview) VALUES($1,$2,$3,$4,$5,$6)',[userId,id,generation,expected,JSON.stringify({request:r.intent,canonical:intent}),JSON.stringify(changes)]);
 return {status:'previewed',actionId:id,intent,impact:changes};
}
export async function commitFinance(db:PoolClient,userId:string,input:unknown){
 const r=object(input,['actionId']),id=uuid(r.actionId),state=await prepareFinance(db,userId),action=(await db.query('SELECT *,expires_at>clock_timestamp() AS fresh FROM finance.action WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(!action)throw new HttpError(404,'NOT_FOUND');if(action.generation!==state.generation)throw new HttpError(409,'GENERATION_CHANGED');if(action.status==='committed')return action.result;
 if(action.expected_revision!==state.revision||!action.fresh)throw new HttpError(409,'FINANCE_CHANGED');
 const undo=await apply(db,userId,action.intent.canonical,state.revision),next=(await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1 RETURNING revision',[userId])).rows[0].revision;
 const result={status:'committed',actionId:id,generation:state.generation,revision:next,impact:action.preview};
 await db.query("UPDATE finance.action SET status='committed',result=$3,undo_patch=$4,committed_at=clock_timestamp(),committed_revision=$5 WHERE user_id=$1 AND id=$2",[userId,id,JSON.stringify(result),JSON.stringify(undo),next]);
 // Retire old history during writes. Scheduled cleanup/deletion cascade is a later block.
 await db.query("DELETE FROM finance.action WHERE user_id=$1 AND created_at<clock_timestamp()-interval '30 days'",[userId]);return result;
}
export async function editFinance(db:PoolClient,userId:string,input:unknown){
 const r=object(input,['actionId','generation','revision','intent']),raw=object(r.intent,['kind','id','patch']);
 if(raw.kind!=='operation'||object(raw.patch,['kind','role','categoryId','subcategoryId','merchant','counterpartyId','comment','analyticsOverride']).corrections!==undefined)throw new HttpError(400,'PREVIEW_REQUIRED');
 await previewFinance(db,userId,r);return commitFinance(db,userId,{actionId:r.actionId});
}
/** Internal account matching hook; source aliases and local HMAC matching arrive with Import. */
export async function acceptAccount(db:PoolClient,userId:string,generation:string,input:unknown){
 const state=await prepareFinance(db,userId);if(uuid(generation)!==state.generation)throw new HttpError(409,'GENERATION_CHANGED');
 const r=object(input,['id','bankId','systemName','type']),id=uuid(r.id),bank=safeText(r.bankId,80),name=safeText(r.systemName,160),type=choice(r.type,['debit_card','credit_card','bank_account','loan','savings','deposit','other']);
 if(!bank||!name)throw new TypeError('INVALID_ACCOUNT');const existing=(await db.query('SELECT bank_id FROM finance.account WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(existing){if(existing.bank_id!==bank)throw new HttpError(409,'ACCOUNT_CONFLICT');return {id};}
 await db.query('INSERT INTO finance.account(user_id,id,bank_id,system_name,display_name,account_type) VALUES($1,$2,$3,$4,$4,$5)',[userId,id,bank,name,type]);
 await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);return {id};
}
/** Internal import acceptance primitive. There is deliberately no public bank-fact upload route.
 * Parser/HMAC/dedupe/cancellation orchestration is a later block. Caller owns the transaction. */
export async function acceptObservation(db:PoolClient,userId:string,generation:string,observationId:string,transactionId:string|null,input:unknown,kind:Kind){
 const state=await prepareFinance(db,userId);if(uuid(generation)!==state.generation)throw new HttpError(409,'GENERATION_CHANGED');uuid(observationId);choice(kind,kinds);
 const r=object(input,['accountId','operationDate','postedDate','amountMinor','currency','operationAmountMinor','operationCurrency','merchantText','description','bankCategory','bankRefHmac','versions']);parsePersistedMinor(r.amountMinor);
 if((r.operationAmountMinor==null)!==(r.operationCurrency==null))throw new TypeError('INVALID_ORIGINAL_CURRENCY');
 if(r.operationAmountMinor!=null){parsePersistedMinor(r.operationAmountMinor);if(typeof r.operationCurrency!=='string'||!/^[A-Z]{3}$/.test(r.operationCurrency))throw new TypeError('INVALID_ORIGINAL_CURRENCY');}
 const versions=object(r.versions,['parser','normalizer','sanitizer','classification']);if(!versions.parser||!versions.normalizer||!versions.sanitizer||Object.values(versions).some(v=>!safeText(v,80)))throw new TypeError('INVALID_VERSIONS');
 const fact:BankFact={accountId:uuid(r.accountId),operationDate:dateFact(r.operationDate),postedDate:r.postedDate===null?null:dateFact(r.postedDate),amountMinor:r.amountMinor as string,currency:choice(r.currency,['RUB']),sourceKind:kind,operationAmountMinor:r.operationAmountMinor as string??null,operationCurrency:r.operationCurrency as string??null,merchantText:safeText(r.merchantText,160),description:safeText(r.description,1000),bankCategory:safeText(r.bankCategory,160),bankRefHmac:r.bankRefHmac===null?null:typeof r.bankRefHmac==='string'&&/^[0-9a-f]{64}$/.test(r.bankRefHmac)?r.bankRefHmac:(()=>{throw new TypeError('INVALID_PSEUDONYM');})(),versions:versions as Record<string,string>};
 const existing=(await db.query('SELECT * FROM finance.source_observation WHERE user_id=$1 AND id=$2',[userId,observationId])).rows[0];
 if(existing){
  const prior={accountId:existing.account_id,operationDate:existing.operation_date,postedDate:existing.posted_date,amountMinor:existing.amount_minor,currency:existing.currency,sourceKind:existing.source_kind,operationAmountMinor:existing.operation_amount_minor,operationCurrency:existing.operation_currency,merchantText:existing.merchant_text,description:existing.description,bankCategory:existing.bank_category,bankRefHmac:existing.bank_ref_hmac,versions:existing.versions};
  if(stable(prior)!==stable(fact)||transactionId!==null&&transactionId!==existing.transaction_id)throw new HttpError(409,'OBSERVATION_REUSED');
  return {transactionId:existing.transaction_id as string,observationId,projection:reconcile((await loadFinance(db,userId)).graph).operations.find(o=>o.id===existing.transaction_id)};
 }
 const {graph,rules}=await loadFinance(db,userId),account=graph.accounts.find(a=>a.id===fact.accountId);if(!account)throw new HttpError(404,'NOT_FOUND');
 const id=transactionId===null?randomUUID():uuid(transactionId);let semantics=initialSemantics(kind,fact.merchantText);
 if(transactionId!==null){
  const previous=await row(db,userId,'transaction',id);semantics=structuredClone(previous.semantics);
  if(!semantics.kind.userVerified&&semantics.kind.source==='bank'){semantics.kind=facet(kind,'bank');if(!semantics.role.userVerified&&semantics.role.source==='deterministic_system_rule')semantics.role=facet(defaultRole(kind));}
  if(!semantics.merchant.userVerified&&semantics.merchant.source==='bank')semantics.merchant=facet(fact.merchantText,'bank');
 }else{
  const op:Operation={id,source:fact,corrections:{},semantics,comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]},classified=applyRules(op,account,rules);
  semantics=classified.semantics;await db.query('INSERT INTO finance.transaction(user_id,id,source_observation_id,semantics,analytics_override,review_reasons) VALUES($1,$2,$3,$4,$5,$6)',[userId,id,observationId,JSON.stringify(semantics),classified.analyticsOverride,JSON.stringify(classified.reviewReasons)]);
 }
 await db.query('INSERT INTO finance.source_observation(user_id,id,transaction_id,account_id,operation_date,posted_date,amount_minor,currency,merchant_text,description,bank_category,bank_ref_hmac,versions,source_kind,operation_amount_minor,operation_currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[userId,observationId,id,fact.accountId,JSON.stringify(fact.operationDate),fact.postedDate===null?null:JSON.stringify(fact.postedDate),fact.amountMinor,fact.currency,fact.merchantText,fact.description,fact.bankCategory,fact.bankRefHmac,JSON.stringify(fact.versions),kind,fact.operationAmountMinor,fact.operationCurrency]);
 if(transactionId!==null)await db.query('UPDATE finance.transaction SET source_observation_id=$3,semantics=$4,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,id,observationId,JSON.stringify(semantics)]);
 await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);return {transactionId:id,observationId,projection:reconcile((await loadFinance(db,userId)).graph).operations.find(o=>o.id===id)};
}
