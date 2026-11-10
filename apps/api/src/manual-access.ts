import {paidAnalyzerUnits} from './customer-ai-budget.ts';
import {reserveMailRequest} from './mail-cooldown.ts';
import type {PoolClient} from 'pg';
import type {FastifyRequest} from 'fastify';
import type {Cycle} from '../../../packages/access/src/renewal.ts';
import type {ManualTerm,QuotaPolicy,ManualPreview,ManualQueue} from '../../../packages/access/src/manual.ts';
import {actionId,remember} from './commerce.ts';
import {cycleView,extensionAt} from './entitlement.ts';
import {clock,fields,string,email,HttpError,outbox} from './types.ts';
import type {Sealer} from './types.ts';
import {token,digest} from './crypto.ts';

function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new HttpError(400,'INVALID_INPUT');
 return value as Record<string,unknown>;
}
function term(value:unknown):ManualTerm{
 const t=object(value,['kind','count','end']);
 if(t.kind==='indefinite'&&Object.keys(t).length===1)return {kind:'indefinite'};
 if(t.kind==='fixed'&&Object.keys(t).length===2&&typeof t.end==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t.end)&&Number.isFinite(Date.parse(t.end))&&new Date(t.end).toISOString()===t.end)return {kind:'fixed',end:new Date(t.end).toISOString()};
 if(['days','calendar_months'].includes(String(t.kind))&&Object.keys(t).length===2&&typeof t.count==='number'&&Number.isInteger(t.count)&&t.count>=1&&t.count<=(t.kind==='days'?36500:1200))return {kind:t.kind as 'days'|'calendar_months',count:t.count};
 throw new HttpError(400,'INVALID_INPUT');
}
function hours(value:unknown){if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>720)throw new HttpError(400,'INVALID_INPUT');return value;}
function limit(value:unknown){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>1000000000)throw new HttpError(400,'INVALID_INPUT');return value;}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
async function quota(db:PoolClient,value:unknown,fallback:QuotaPolicy|undefined):Promise<QuotaPolicy>{
 if(value===undefined){if(fallback)return fallback;throw new HttpError(400,'QUOTA_REQUIRED');}
 const q=object(value,['source','tariffId','limit','budgetMinor']);
 if(q.source==='override'&&Object.keys(q).length===2){
  if(typeof q.budgetMinor==='string'&&/^\d{1,7}$/.test(q.budgetMinor))return {source:'override',limit:Number(q.budgetMinor)};
  return {source:'override',limit:limit(q.limit)};
 }
 if(q.source==='tariff'&&Object.keys(q).length===2){
  const id=string(q.tariffId,100),t=(await db.query("SELECT snapshot FROM access.tariff WHERE id=$1 AND snapshot->>'active'='true'",[id])).rows[0]?.snapshot;
  if(!t||typeof t.aiQuota!=='number'||!Number.isSafeInteger(t.aiQuota)||t.aiQuota<0||t.aiQuota>1000000000)throw new HttpError(409,'TARIFF_UNAVAILABLE');
  return {source:'tariff',tariffId:id,limit:paidAnalyzerUnits(id,t.duration.kind,t.aiQuota),...(t.duration.kind==='days'&&t.duration.count<=366?{periodDays:t.duration.count}:{})};
 }
 throw new HttpError(400,'INVALID_INPUT');
}
export async function manualQueue(db:PoolClient,options?:{search:string;filter:string;page:number;target:string}):Promise<ManualQueue>{
 const size=options?30:100;
 const users=(await db.query(`SELECT d.*,c.user_id AS cycle_id,c.anchor_at,c.access_end,c.timezone,c.revision,c.calendar_months,c.extra_days,c.indefinite,c.end_offset_ms,c.quota_policy
  FROM commerce.account_directory d LEFT JOIN commerce.access_cycle c USING(user_id)
  WHERE ($1='' OR strpos(lower(d.email||' '||d.name),lower($1))>0) AND
   ($2='' OR $2='blocked' AND d.status='suspended' OR $2='unlimited' AND c.indefinite OR
    $2='active' AND c.access_end>clock_timestamp() OR $2='expired' AND c.access_end<=clock_timestamp())
  ORDER BY (d.user_id=$3) DESC,d.registered_at DESC,d.user_id LIMIT $4 OFFSET $5`,
  [options?.search??'',options?.filter??'',options?.target??'',size+1,(options?.page??0)*size])).rows;
 const hasMore=users.length>size;users.splice(size);
 const limits=new Map((await db.query('SELECT * FROM commerce.control_customer_allowances($1)',[users.map(u=>u.user_id)])).rows.map(r=>[r.user_id,{units:r.units,remaining:r.remaining,used:r.used,purchased:r.purchased,manual:r.manual,spentAtoms:r.spent_atoms,budgetMinor:r.budget_minor,resetAt:r.reset_at?.toISOString()??null}]));
 const invites=options?[]:(await db.query(`SELECT i.id,i.manual_grant_id AS "grantId",i.email,i.created_at AS "createdAt",i.expires_at AS "expiresAt",
  COALESCE((SELECT d.state FROM mail.delivery d WHERE d.subject_id=i.id AND d.kind='invitation' ORDER BY d.created_at DESC LIMIT 1),'queued') AS delivery,CASE WHEN i.state='active' AND i.expires_at<=clock_timestamp() THEN 'expired' ELSE i.state END AS state,
  g.term,g.access_type AS "accessType",g.quota_policy AS quota,g.reason FROM commerce.invitation i JOIN commerce.manual_grant g ON g.id=i.manual_grant_id ORDER BY i.created_at DESC,i.id DESC LIMIT 100`)).rows;
 return {hasMore,users:users.map(u=>({userId:u.user_id,email:u.email,name:u.name,status:u.status,registeredAt:u.registered_at.toISOString(),cycle:u.cycle_id?cycleView(u):null,analyzer:limits.get(u.user_id)})),invitations:invites,
  audit:options?[]:(await db.query('SELECT data FROM commerce.manual_access_audit ORDER BY created_at DESC,action_id DESC LIMIT 100')).rows.map(r=>r.data),
  tariffs:(await db.query('SELECT snapshot FROM access.tariff ORDER BY id')).rows.map(r=>r.snapshot).filter(t=>t.active===true&&Number.isSafeInteger(t.aiQuota)&&t.aiQuota>=0&&t.aiQuota<=1000000000).map(t=>({id:t.id,name:t.name,aiQuota:paidAnalyzerUnits(t.id,t.duration.kind,t.aiQuota),priceMinor:t.priceMinor,duration:t.duration}))};
}
async function availableEmail(db:PoolClient,address:string,now:string){
 if((await db.query('SELECT 1 FROM commerce.account_directory WHERE email=$1',[address])).rowCount)throw new HttpError(409,'EXISTING_ACCOUNT');
 const existing=await db.query(`SELECT 1 FROM commerce.manual_grant WHERE email=$1 AND state='pending' AND (term->>'kind'!='fixed' OR (term->>'end')::timestamptz>$2::timestamptz)
  UNION ALL SELECT 1 FROM access.request WHERE email=$1 AND data->>'status'!='rejected'
   AND (data->>'status' NOT IN ('awaiting_email','awaiting_payment') OR (data->>'expiresAt')::timestamptz>$2::timestamptz)`,[address,now]);
 if(existing.rowCount)throw new HttpError(409,'PENDING_ACCESS');
}
async function newInvitation(db:PoolClient,grantId:string,address:string,lifetime:number,seal:Sealer,now:string){
 const secret=token(),id=crypto.randomUUID(),expires=new Date(Date.parse(now)+lifetime*3600000).toISOString();
 await db.query(`INSERT INTO commerce.invitation(id,manual_grant_id,email,verifier,sealed_token,expires_at,state,created_at) VALUES($1,$2,$3,$4,$5,$6,'active',$7)`,[id,grantId,address,digest(secret),seal.seal(secret),expires,now]);
 await outbox(db,'access',seal,'invitation',{email:address,token:secret,expiresAt:expires},{subjectId:id,expiresAt:expires});
 return expires;
}
export async function manualAccess(db:PoolClient,request:FastifyRequest,actorId:string,seal:Sealer,preview:boolean){
 const b=fields(request,['actionId','mode','reason','email','userId','term','accessType','quota','inviteHours','expectedRevision','expectedMode','expectedQuota']);
 const id=actionId(b.actionId),reason=string(b.reason,1000).trim(),mode=string(b.mode,20);
 if(!['invite','extend','set_end','indefinite','end_now','quota'].includes(mode))throw new HttpError(400,'INVALID_INPUT');
 if(!preview&&(!Number.isInteger(b.expectedRevision)||typeof b.expectedMode!=='string'||!b.expectedQuota))throw new HttpError(400,'INVALID_INPUT');
 const t=mode==='end_now'||mode==='quota'?undefined:term(b.term);
 if((mode==='extend'&&t?.kind!=='days'&&t?.kind!=='calendar_months')||(mode==='set_end'&&t?.kind!=='fixed')||(mode==='indefinite'&&t?.kind!=='indefinite')||(mode==='end_now'&&b.term!==undefined))throw new HttpError(400,'INVALID_INPUT');
 if(mode==='invite'?(b.userId!==undefined||!['Paid','Test','Free','Other'].includes(String(b.accessType))):(b.email!==undefined||b.accessType!==undefined||b.inviteHours!==undefined))throw new HttpError(400,'INVALID_INPUT');
 const address=mode==='invite'?email(b.email):undefined,userId=mode==='invite'?undefined:string(b.userId,100),lifetime=mode==='invite'?hours(b.inviteHours):undefined;
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['manual-action:'+id]);
 if(!preview&&await remember(db,id,actorId,{kind:'manual_access',...b,reason,...(address?{email:address}:{})}))return {status:'already_committed',...await manualQueue(db)};
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[address?'access-email:'+address:'access-cycle:'+userId]);
 const account=userId?(await db.query('SELECT * FROM commerce.account_directory WHERE user_id=$1',[userId])).rows[0]:null;
 if(userId&&!account)throw new HttpError(404,'NOT_FOUND');
 const r=userId?(await db.query('SELECT * FROM commerce.access_cycle WHERE user_id=$1',[userId])).rows[0]:null;
 const before=r?cycleView(r):null,now=await clock(db);
 const previousMode=address?'new':!before?'absent':before.indefinite?'indefinite':before.accessEnd&&Date.parse(before.accessEnd)>Date.parse(now)?'continuous':'restored';
 if(!preview&&(b.expectedRevision!==(before?.revision??-1)||b.expectedMode!==previousMode))throw new HttpError(409,'PREVIEW_CHANGED');
 const q=await quota(db,b.quota,r?.quota_policy??undefined);
 if(!preview&&!same(q,b.expectedQuota))throw new HttpError(409,'PREVIEW_CHANGED');
 if(t?.kind==='fixed'&&(Date.parse(t.end)<=Date.parse(now)||Date.parse(t.end)-Date.parse(now)>3153600000000))throw new HttpError(409,'INVALID_END');
 let next:Cycle|null=null;
 if(address)await availableEmail(db,address,now);
 else{
  const base:Cycle=before??{anchorAt:now,accessEnd:now,timezone:'Europe/Moscow',revision:-1,calendarMonths:0,extraDays:0};
  next={...base,revision:base.revision+1,quotaPolicy:q};
  if(mode==='extend'){
   if(base.indefinite)throw new HttpError(409,'CYCLE_INDEFINITE');
   const result=await extensionAt(db,base,t as {kind:'days'|'calendar_months';count:number},now,'manual:'+id,id);
   next={...next,anchorAt:result.extension.anchorAt,accessEnd:result.extension.accessEnd,calendarMonths:result.calendarMonths,extraDays:result.extraDays,indefinite:false,endOffsetMs:previousMode==='continuous'?(base.endOffsetMs??0):0};
  }else if(mode==='indefinite')next={...next,accessEnd:null,indefinite:true};
  else if(mode==='quota'){if(!before||!b.quota)throw new HttpError(409,'QUOTA_REQUIRED');}
  else{
   if(mode==='end_now'&&!before)throw new HttpError(409,'CYCLE_UNAVAILABLE');
   const end=mode==='end_now'?now:(t as {kind:'fixed';end:string}).end;
   const grid=(await db.query(`SELECT ((($1::timestamptz AT TIME ZONE $2)+make_interval(months=>$3)) AT TIME ZONE $2)+($4*interval '24 hours') AS finish`,[base.anchorAt,base.timezone,base.calendarMonths,base.extraDays])).rows[0].finish.toISOString();
   next={...next,accessEnd:end,indefinite:false,endOffsetMs:Date.parse(end)-Date.parse(grid)};
  }
 }
 if(mode==='quota'&&q.source==='override'&&next&&!next.indefinite&&(!next.accessEnd||Date.parse(next.accessEnd)<=Date.parse(now)))throw new HttpError(409,'ALLOWANCE_ACCESS_EXPIRED');
 const paidUntil=mode==='quota'&&account&&q.source==='tariff'?(await db.query("SELECT commerce.control_paid_allowance_end($1) AS finish",[userId])).rows[0]?.finish:null;
 const result:ManualPreview={...(paidUntil?{effectiveAt:paidUntil.toISOString()}:{}),mode,previousMode,previous:before,next,quota:q,email:address??account.email,blocked:account?.status==='suspended',expectedRevision:before?.revision??-1,...(t?{term:t}:{}),...(lifetime?{inviteHours:lifetime}:{})};
 if(preview)return result;
 if(address){
  // Only an actually ended fixed grant can release this reservation. Link expiry alone never does.
  const expired=await db.query("UPDATE commerce.manual_grant SET state='expired' WHERE email=$1 AND state='pending' AND term->>'kind'='fixed' AND (term->>'end')::timestamptz<=$2::timestamptz RETURNING id",[address,now]);
  if(expired.rowCount)await db.query("UPDATE commerce.invitation SET state='expired' WHERE manual_grant_id=ANY($1::text[]) AND state='active'",[expired.rows.map(r=>r.id)]);
  const grantId='manual:'+id;
  await db.query('INSERT INTO commerce.manual_grant(id,email,term,access_type,quota_policy,reason,creator,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[grantId,address,t,b.accessType,q,reason,actorId,now]);
  await newInvitation(db,grantId,address,lifetime!,seal,now);
 }else if(next){
  await db.query(`INSERT INTO commerce.access_cycle(user_id,anchor_at,access_end,timezone,revision,calendar_months,extra_days,indefinite,end_offset_ms,quota_policy)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id) DO UPDATE SET anchor_at=EXCLUDED.anchor_at,access_end=EXCLUDED.access_end,revision=EXCLUDED.revision,calendar_months=EXCLUDED.calendar_months,extra_days=EXCLUDED.extra_days,indefinite=EXCLUDED.indefinite,end_offset_ms=EXCLUDED.end_offset_ms,quota_policy=EXCLUDED.quota_policy`,
   [userId,next.anchorAt,next.accessEnd,next.timezone,next.revision,next.calendarMonths,next.extraDays,next.indefinite??false,next.endOffsetMs??0,q]);
  if(b.quota&&q.source==='override'&&next.accessEnd&&Date.parse(next.accessEnd)>Date.parse(now)){
   const saved=(await db.query('SELECT commerce.set_customer_allowance($1,$2,$3,$4) AS saved',[userId,now,next.accessEnd,q.limit])).rows[0]?.saved;
   if(!saved)throw new HttpError(409,'ALLOWANCE_COST_PENDING');
  }else if(mode!=='quota'){
   await db.query('SELECT commerce.move_customer_allowance_end($1,$2,$3)',[userId,now,b.quota?null:next.accessEnd]);
  }
  if(b.quota&&q.source==='override'&&next.indefinite)await db.query('INSERT INTO commerce.manual_allowance(user_id,starts_at,units) VALUES($1,$2,$3)',[userId,now,q.limit]);
  if(b.quota&&q.source==='tariff'&&!same(q,before?.quotaPolicy))await db.query('INSERT INTO commerce.manual_allowance(user_id,starts_at,units,period_days) VALUES($1,$2,$3,$4)',[userId,now,q.limit,q.periodDays??null]);
  await outbox(db,'access',seal,mode==='quota'?'manual_quota_changed':'manual_access_changed',{email:account.email,accessEnd:next.accessEnd,indefinite:next.indefinite??false,...(b.quota&&q.source==='tariff'?{analyzerUnits:q.limit,periodDays:q.periodDays}:{}),...(b.quota&&q.source==='override'?{analyzerUnits:q.limit}:{})},{subjectId:userId,dedupeKey:'manual-access:'+id});
 }
 const audit={changes:mode==='quota'?[{label:'Политика лимита Анализатора',before:before?.quotaPolicy??null,after:q}]:[],actionId:id,actorId,at:now,email:result.email,userId:userId??null,mode,reason,before,after:next,quota:q};
 await db.query('INSERT INTO commerce.manual_access_audit(action_id,user_id,data,created_at) VALUES($1,$2,$3,$4)',[id,userId??null,audit,now]);
 return {status:'committed',...await manualQueue(db)};
}
export async function manualInvitationAction(db:PoolClient,request:FastifyRequest,actorId:string,seal:Sealer){
 const b=fields(request,['actionId','invitationId','decision','reason','inviteHours']),id=actionId(b.actionId),inviteId=string(b.invitationId,100),reason=string(b.reason,1000).trim(),lifetime=hours(b.inviteHours);
 if(!['cancel','reissue'].includes(String(b.decision)))throw new HttpError(400,'INVALID_INPUT');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['manual-action:'+id]);
 if(await remember(db,id,actorId,{kind:'manual_invitation',...b,reason}))return {status:'already_committed',...await manualQueue(db)};
 const ref=(await db.query('SELECT manual_grant_id,email FROM commerce.invitation WHERE id=$1',[inviteId])).rows[0];if(!ref?.manual_grant_id)throw new HttpError(404,'NOT_FOUND');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-email:'+ref.email]);
 const grant=(await db.query('SELECT * FROM commerce.manual_grant WHERE id=$1 FOR UPDATE',[ref.manual_grant_id])).rows[0];
 const invite=(await db.query('SELECT * FROM commerce.invitation WHERE id=$1 FOR UPDATE',[inviteId])).rows[0];
 if(grant.state!=='pending'||['used','superseded'].includes(invite.state)||b.decision==='cancel'&&invite.state!=='active')throw new HttpError(409,'INVITATION_UNAVAILABLE');
 const now=await clock(db);
 if(b.decision==='reissue'&&grant.term.kind==='fixed'&&Date.parse(grant.term.end)<=Date.parse(now))throw new HttpError(409,'INVALID_END');
 await db.query('UPDATE commerce.invitation SET state=$1 WHERE id=$2',[b.decision==='cancel'?'cancelled':'superseded',inviteId]);
 let newExpiry:string|null=null;
 if(b.decision==='reissue'){await reserveMailRequest(db,seal,'control','invitation-resend',ref.email);newExpiry=await newInvitation(db,grant.id,ref.email,lifetime,seal,now);}
 const changes=b.decision==='cancel'?[{label:'Статус ссылки',before:'Действует',after:'Отменена'}]:[{label:'Срок ссылки',before:invite.expires_at,after:newExpiry}];
 await db.query('INSERT INTO commerce.manual_access_audit(action_id,data,created_at) VALUES($1,$2,$3)',[id,{actionId:id,actorId,at:now,email:ref.email,userId:null,mode:'invitation_'+b.decision,reason,before:null,after:null,quota:grant.quota_policy,changes},now]);
 return {status:'committed',...await manualQueue(db)};
}
