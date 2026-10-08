import type { PoolClient } from 'pg';
import type { FastifyRequest } from 'fastify';
import { emptyAccessStore, reviewRequest, changeInvitation } from '@finance/access';
import type { AccessStore, AccessRequest, ReviewCommand } from '@finance/access';
import { clock, fields, string, HttpError, outbox, event } from './types.ts';
import type { Sealer } from './types.ts';
import { token, digest } from './crypto.ts';

export function actionId(value: unknown) { const v=string(value,36); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) throw new HttpError(400,'INVALID_INPUT'); return v; }
function hours(value: unknown) { const v=value ?? 72; if(typeof v!=='number'||!Number.isInteger(v)||v<1||v>720)throw new HttpError(400,'INVALID_INPUT');return v; }
async function load(db:PoolClient,requestId:string):Promise<AccessStore> {
  const row=(await db.query('SELECT data FROM access.request WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
  if(!row)throw new HttpError(404,'NOT_FOUND');
  const saved=(await db.query('SELECT data FROM commerce.review_state WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
  const store=saved?.data as AccessStore|undefined;
  // Always re-read the application: a user may have submitted a top-up claim since the last review.
  return {...(store??emptyAccessStore()),requests:[row.data as AccessRequest]};
}
export async function remember(db:PoolClient,id:string,actor:string,payload:Record<string,unknown>) {
  const previous=(await db.query('SELECT actor_id,payload FROM commerce.action WHERE id=$1',[id])).rows[0];
  if(previous) {
    // JSONB equality does not depend on object-key order; actor is derived from the verified session.
    const same=(await db.query('SELECT actor_id=$2 AND payload=$3::jsonb AS same FROM commerce.action WHERE id=$1',[id,actor,JSON.stringify(payload)])).rows[0].same;
    if(!same)throw new HttpError(409,'ACTION_CONFLICT');return true;
  }
  await db.query('INSERT INTO commerce.action(id,actor_id,payload) VALUES($1,$2,$3)',[id,actor,payload]);return false;
}
async function save(db:PoolClient,before:AccessStore,next:AccessStore,seal:Sealer,lifetime:number) {
  const row=next.requests[0]!;
  await db.query('UPDATE access.request SET data=$1 WHERE id=$2',[row,row.id]);
  await db.query(`INSERT INTO commerce.review_state(request_id,data) VALUES($1,$2) ON CONFLICT(request_id) DO UPDATE SET data=EXCLUDED.data`,[row.id,next]);
  for(const purchase of next.purchases.filter(p=>!before.purchases.some(old=>old.id===p.id))) {
    await db.query('INSERT INTO commerce.purchase(id,request_id,data) VALUES($1,$2,$3)',[purchase.id,row.id,purchase]);
  }
  for(const invite of next.invitations) {
    const old=before.invitations.find(i=>i.id===invite.id);
    if(old) { if(old.state!==invite.state)await db.query('UPDATE commerce.invitation SET state=$1 WHERE id=$2 AND state!=\'used\'',[invite.state,invite.id]);continue; }
    const secret=token();
    invite.expiresAt=new Date(Date.parse(invite.createdAt)+lifetime*3600000).toISOString();
    await db.query(`INSERT INTO commerce.invitation(id,purchase_id,email,verifier,sealed_token,expires_at,state,created_at) VALUES($1,$2,$3,$4,$5,$6,'active',$7)`,[invite.id,invite.purchaseId,invite.email,digest(secret),seal.seal(secret),invite.expiresAt,invite.createdAt]);
    await outbox(db,'access',seal,'invitation',{email:invite.email,token:secret,expiresAt:invite.expiresAt},{subjectId:invite.id,expiresAt:invite.expiresAt});
  }
  // Persist the actual link lifetime alongside the immutable purchase duration.
  await db.query('UPDATE commerce.review_state SET data=$1 WHERE request_id=$2',[next,row.id]);
}
export async function queue(db:PoolClient) {
  const requests=(await db.query('SELECT data FROM access.request ORDER BY created_at DESC LIMIT 100')).rows.map(r=>r.data);
  const ids=requests.map(r=>r.id);
  const states=(await db.query('SELECT data FROM commerce.review_state WHERE request_id=ANY($1::text[])',[ids])).rows.map(r=>r.data as AccessStore);
  return {requests,payments:states.flatMap(s=>s.payments),audit:states.flatMap(s=>s.audit),
    purchases:(await db.query('SELECT data,state,activated_at,access_end FROM commerce.purchase WHERE request_id=ANY($1::text[])',[ids])).rows.map(r=>({...r.data,state:r.state,activatedAt:r.activated_at,accessEnd:r.access_end})),
    invitations:(await db.query(`SELECT i.id,i.purchase_id AS "purchaseId",p.request_id AS "requestId",i.email,i.created_at AS "createdAt",i.expires_at AS "expiresAt",COALESCE((SELECT d.state FROM mail.delivery d WHERE d.subject_id=i.id AND d.kind='invitation' ORDER BY d.created_at DESC LIMIT 1),'queued') AS delivery,CASE WHEN i.state='active' AND i.expires_at<=clock_timestamp() THEN 'expired' ELSE i.state END AS state FROM commerce.invitation i JOIN commerce.purchase p ON p.id=i.purchase_id WHERE p.request_id=ANY($1::text[]) ORDER BY i.created_at,i.id`,[ids])).rows};
}
export async function review(db:PoolClient,request:FastifyRequest,actorId:string,seal:Sealer,preview:boolean) {
  const b=fields(request,['actionId','requestId','expectedRevision','actualMinor','receivedAt','decision','reason','customDays','inviteHours']);
  const id=actionId(b.actionId), requestId=string(b.requestId,100), lifetime=hours(b.inviteHours);
  if(!Number.isSafeInteger(b.expectedRevision)||typeof b.reason!=='string'||b.reason.length>1000||b.customDays!==undefined&&(typeof b.customDays!=='number'||!Number.isInteger(b.customDays)||b.customDays<1||b.customDays>36500))throw new HttpError(400,'INVALID_INPUT');
  const cmd:ReviewCommand={actionId:id,requestId,actorId,expectedRevision:b.expectedRevision as number,actualMinor:string(b.actualMinor,30),receivedAt:string(b.receivedAt,32),decision:string(b.decision,20) as ReviewCommand['decision'],reason:b.reason,...(b.customDays!==undefined?{customDays:b.customDays as number}:{})};
  const before=await load(db,requestId);
  if(!preview&&await remember(db,id,actorId,{kind:'review',...cmd,inviteHours:lifetime}))return {status:'already_committed',...(await queue(db))};
  let next:AccessStore;try {next=reviewRequest(before,cmd,await clock(db));}catch {throw new HttpError(409,'REVIEW_CONFLICT');}
  if(preview)return {request:next.requests[0],payment:next.payments.find(p=>p.actionId===id),purchase:next.purchases.find(p=>p.id==='purchase:'+id),inviteHours:lifetime};
  await save(db,before,next,seal,lifetime);
  await outbox(db,'access',seal,'payment_decision',{email:before.requests[0]!.email,status:next.requests[0]!.status,remainingMinor:next.requests[0]!.remainingMinor},{subjectId:requestId});
  return {status:'committed',...(await queue(db))};
}
export async function invitationAction(db:PoolClient,request:FastifyRequest,actorId:string,seal:Sealer) {
  const b=fields(request,['actionId','invitationId','decision','reason','inviteHours']);
  const id=actionId(b.actionId),invitationId=string(b.invitationId,100),reason=string(b.reason,1000).trim(),lifetime=hours(b.inviteHours);
  if(!['cancel','reissue'].includes(String(b.decision)))throw new HttpError(400,'INVALID_INPUT');
  const meta=(await db.query('SELECT p.request_id FROM commerce.invitation i JOIN commerce.purchase p ON p.id=i.purchase_id WHERE i.id=$1',[invitationId])).rows[0];
  if(!meta)throw new HttpError(404,'NOT_FOUND');
  const before=await load(db,meta.request_id);
  const cmd={actionId:id,invitationId,actorId,decision:b.decision as 'cancel'|'reissue',reason};
  if(await remember(db,id,actorId,{kind:'invitation',...cmd,inviteHours:lifetime}))return {status:'already_committed',...(await queue(db))};
  const purchase=(await db.query('SELECT p.state FROM commerce.purchase p JOIN commerce.invitation i ON i.purchase_id=p.id WHERE i.id=$1 FOR UPDATE OF p',[invitationId])).rows[0];
  const actual=(await db.query('SELECT state FROM commerce.invitation WHERE id=$1 FOR UPDATE',[invitationId])).rows[0];
  if(purchase.state!=='paid_not_activated'||actual.state==='used')throw new HttpError(409,'INVITATION_UNAVAILABLE');
  let next:AccessStore;try {next=changeInvitation(before,cmd,await clock(db));}catch {throw new HttpError(409,'INVITATION_UNAVAILABLE');}
  await save(db,before,next,seal,lifetime);return {status:'committed',...(await queue(db))};
}
export async function copyInvitation(db:PoolClient,request:FastifyRequest,actorId:string,seal:Sealer) {
  const b=fields(request,['invitationId']);
  const row=(await db.query(`SELECT i.sealed_token,i.expires_at FROM commerce.invitation i LEFT JOIN commerce.purchase p ON p.id=i.purchase_id LEFT JOIN commerce.manual_grant g ON g.id=i.manual_grant_id WHERE i.id=$1 AND i.state='active' AND i.expires_at>clock_timestamp() AND (p.state='paid_not_activated' OR g.state='pending' AND (g.term->>'kind'!='fixed' OR (g.term->>'end')::timestamptz>clock_timestamp()))`,[string(b.invitationId,100)])).rows[0];
  if(!row)throw new HttpError(409,'INVITATION_UNAVAILABLE');
  await event(db,'control',actorId,'invitation_link_copied');return {token:seal.open(row.sealed_token),expiresAt:row.expires_at};
}
