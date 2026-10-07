import type {PoolClient} from 'pg';
import type {FastifyRequest} from 'fastify';
import {reviewRequest} from '@finance/access';
import type {AccessStore,ReviewCommand} from '@finance/access';
import type {RenewalRow,RenewalQueue,RenewalPreview} from '../../../packages/access/src/renewal.ts';
import {actionId,remember} from './commerce.ts';
import {lockedCycle,extensionAt} from './entitlement.ts';
import {clock,fields,string,HttpError,outbox} from './types.ts';
import type {Sealer} from './types.ts';
export async function renewalQueue(db:PoolClient):Promise<RenewalQueue>{
 const rows=(await db.query('SELECT data,review_state,state FROM commerce.renewal_request ORDER BY created_at DESC,id DESC LIMIT 100')).rows;
 const ids=rows.map(r=>r.data.id),extensions=(await db.query('SELECT data FROM commerce.access_extension WHERE request_id=ANY($1::text[])',[ids])).rows.map(r=>r.data);
 return {requests:rows.map(r=>({...r.data,renewalState:r.state,accessEnd:extensions.find(e=>e.requestId===r.data.id)?.accessEnd})),payments:rows.flatMap(r=>r.review_state.payments),audit:rows.flatMap(r=>r.review_state.audit),extensions};
}
export async function reviewRenewal(db:PoolClient,request:FastifyRequest,actorId:string,seal:Sealer,preview:boolean){
 const b=fields(request,['actionId','requestId','expectedRevision','actualMinor','receivedAt','decision','reason','customDays','expectedCycleRevision','expectedMode']);
 const id=actionId(b.actionId),requestId=string(b.requestId,100);
 if(!Number.isSafeInteger(b.expectedRevision)||typeof b.reason!=='string'||b.reason.length>1000||b.customDays!==undefined&&(typeof b.customDays!=='number'||!Number.isInteger(b.customDays)||b.customDays<1||b.customDays>36500))throw new HttpError(400,'INVALID_INPUT');
 if(!preview&&(!Number.isSafeInteger(b.expectedCycleRevision)||!['continuous','restored'].includes(String(b.expectedMode))))throw new HttpError(400,'INVALID_INPUT');
 const cmd:ReviewCommand={actionId:id,requestId,expectedRevision:b.expectedRevision as number,actorId,actualMinor:string(b.actualMinor,30),receivedAt:string(b.receivedAt,32),decision:string(b.decision,20) as ReviewCommand['decision'],reason:b.reason,...(b.customDays!==undefined?{customDays:b.customDays as number}:{})};
 const ref=(await db.query('SELECT user_id FROM commerce.renewal_request WHERE id=$1',[requestId])).rows[0];if(!ref)throw new HttpError(404,'NOT_FOUND');
 // Shared lock order in both profiles: cycle then renewal; re-read the request after the lock.
 const cycle=await lockedCycle(db,ref.user_id),row=(await db.query('SELECT * FROM commerce.renewal_request WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
 if(!preview&&await remember(db,id,actorId,{kind:'renewal',...cmd,expectedCycleRevision:b.expectedCycleRevision,expectedMode:b.expectedMode}))return {status:'already_committed',...await renewalQueue(db)};
 if(row.state!=='open')throw new HttpError(409,'RENEWAL_CONFLICT');
 const before={...row.review_state,requests:[row.data]} as AccessStore,now=await clock(db),mode=Date.parse(cycle.accessEnd)>Date.parse(now)?'continuous':'restored';
 if(!preview&&(cycle.revision!==b.expectedCycleRevision||mode!==b.expectedMode))throw new HttpError(409,'PREVIEW_CHANGED');
 let next:AccessStore;try{next=reviewRequest(before,cmd,now);}catch{throw new HttpError(409,'REVIEW_CONFLICT');}
 const purchase=next.purchases.find(p=>p.id==='purchase:'+id),result=purchase?await extensionAt(db,cycle,purchase.duration,now,requestId,id):null;
 const state:RenewalRow['renewalState']=purchase?'completed':cmd.decision==='reject'?'rejected':'open';
 const projection:RenewalPreview={request:{...next.requests[0]!,renewalState:state},payment:next.payments.find(p=>p.actionId===id),cycleRevision:cycle.revision,mode,...(result?{duration:purchase!.duration,extension:result.extension}:{})};
 if(preview)return projection;
 // Reuse money decisions only. Renewal never issues a first-access purchase or invitation.
 next={...next,purchases:[],invitations:[]};
 await db.query('UPDATE commerce.renewal_request SET data=$1,review_state=$2,state=$3 WHERE id=$4',[next.requests[0],next,state,requestId]);
 if(result){
   const e=result.extension;
   await db.query('UPDATE commerce.access_cycle SET anchor_at=$1,access_end=$2,calendar_months=$3,extra_days=$4,revision=revision+1 WHERE user_id=$5',[e.anchorAt,e.accessEnd,result.calendarMonths,result.extraDays,ref.user_id]);
   await db.query('INSERT INTO commerce.access_extension(action_id,request_id,user_id,data) VALUES($1,$2,$3,$4)',[id,requestId,ref.user_id,e]);
 }
 await outbox(db,'access',seal,'renewal_decision',{email:row.data.email,status:state==='completed'?'completed':next.requests[0]!.status,remainingMinor:next.requests[0]!.remainingMinor,...(result?{accessEnd:result.extension.accessEnd}:{})});
 return {status:'committed',...await renewalQueue(db)};
}
