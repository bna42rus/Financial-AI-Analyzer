import type {PoolClient} from 'pg';
import {requestStatus} from '../../../packages/access/src/model.ts';
import type {AccessRequest} from '../../../packages/access/src/model.ts';
import {actionId,remember} from './commerce.ts';
import {deletionQueue} from './account-deletion.ts';
import {clock,HttpError,outbox,string} from './types.ts';
import type {Sealer} from './types.ts';

export async function adminPreferences(db:PoolClient,actor:string,input?:Record<string,unknown>){
 if(input){
  const zone=string(input.timezone,100);
  if(zone!=='device'&&!(await db.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[zone])).rowCount)throw new HttpError(400,'INVALID_ADMIN_TIMEZONE');
  await db.query('INSERT INTO control.display_preferences(user_id,timezone) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET timezone=EXCLUDED.timezone',[actor,zone]);
 }
 return {timezone:(await db.query('SELECT timezone FROM control.display_preferences WHERE user_id=$1',[actor])).rows[0]?.timezone??'device'};
}

export async function changeUserAccessStatus(db:PoolClient,actor:string,input:Record<string,unknown>,seal:Sealer){
 const id=actionId(input.actionId),userId=string(input.userId,100),note=string(input.note,1000).trim();
 const next=input.status;
 if(next!=='active'&&next!=='suspended'||typeof input.endSessions!=='boolean')throw new HttpError(400,'INVALID_INPUT');
 const before=next==='suspended'?'active':'suspended';
 const account=(await db.query('SELECT email FROM commerce.account_directory WHERE user_id=$1',[userId])).rows[0];
 if(!account)throw new HttpError(404,'NOT_FOUND');
 const payload={kind:'user_access_status',decision:next,userId,reason:note,changes:[{label:'Ограничение аккаунта',before:before==='active'?'Доступ разрешён':'Доступ приостановлен',after:next==='active'?'Доступ разрешён':'Доступ приостановлен'}],endSessions:input.endSessions};
 if(await remember(db,id,actor,payload))return {status:next};
 if(!(await db.query('SELECT commerce.control_user_access_status($1,$2,$3,$4) AS changed',[userId,before,next,input.endSessions])).rows[0]?.changed)throw new HttpError(409,'USER_STATUS_CHANGED');
 if(next==='suspended')await db.query('SELECT commerce.stop_customer_allowance($1,clock_timestamp())',[userId]);
 await outbox(db,'access',seal,'account_access_status',{email:account.email,blocked:next==='suspended'},{subjectId:userId,dedupeKey:'account-access-status:'+id});
 return {status:next};
}

export async function adminInvitations(db:PoolClient,target?:string){
 return {invitations:(await db.query(`SELECT i.id,i.email,i.created_at AS "createdAt",i.expires_at AS "expiresAt",i.used_at AS "usedAt",
  CASE WHEN i.state='active' AND i.expires_at<=clock_timestamp() THEN 'expired' ELSE i.state END AS state,
  COALESCE(last_mail.state,'queued') AS delivery,last_mail.id AS "deliveryId",
  CASE WHEN i.manual_grant_id IS NULL THEN 'paid' ELSE 'manual' END AS origin,p.request_id AS "requestId",
  g.term AS "manualTerm",g.reason AS note,p.state AS "purchaseState"
  FROM commerce.invitation i LEFT JOIN commerce.purchase p ON p.id=i.purchase_id
  LEFT JOIN commerce.manual_grant g ON g.id=i.manual_grant_id
  LEFT JOIN LATERAL (SELECT id,state FROM mail.delivery WHERE subject_id=i.id AND kind IN ('invitation','billing_invitation') ORDER BY created_at DESC,id DESC LIMIT 1) last_mail ON true
  ORDER BY (i.id IS NOT DISTINCT FROM $1) DESC,i.created_at DESC,i.id DESC LIMIT 500`,[target??null])).rows};
}

export async function adminRequests(db:PoolClient,target?:string){
 const now=await clock(db);
 const {invitations}=await adminInvitations(db);
 const orders=(await db.query('SELECT * FROM commerce.control_checkout_queue()')).rows;
 const byApplication=new Map<string,typeof orders[number]>();
 for(const order of orders)if(order.application_id&&(!byApplication.has(order.application_id)||+order.created_at>+byApplication.get(order.application_id)!.created_at))byApplication.set(order.application_id,order);
 const applications=(await db.query<{data:AccessRequest;state:string|null;activated_at:Date|null;access_end:Date|null}>(`SELECT r.data,p.state,p.activated_at,p.access_end FROM access.request r
  LEFT JOIN commerce.purchase p ON p.request_id=r.id ORDER BY (r.id IS NOT DISTINCT FROM $1) DESC,r.created_at DESC LIMIT 500`,[target??null])).rows;
 const first=applications.map(({data,state,activated_at,access_end})=>{
  const order=byApplication.get(data.id),invite=invitations.find(i=>i.requestId===data.id);
  const displayStatus=state==='active'?'registered':state==='refunded'||data.status==='rejected'?'closed':
   order?.status==='reconcile'?'reconcile':data.status==='paid_not_activated'?(invite?.state==='active'?'registration':'newLink'):
   requestStatus(data,now)==='expired'&&(!order||order.status==='cancelled')?'expired':data.verifiedAt?'pay':'email';
  return {id:data.id,email:data.email,at:data.createdAt,type:'first',status:displayStatus,tariff:data.tariff.name,priceMinor:data.tariff.priceMinor,
   paymentId:order?.id,invitationId:invite?.id,invitationState:invite?.state,mail:invite?.delivery,inviteUntil:invite?.expiresAt,
   activatedAt:activated_at,accessEnd:access_end,attention:['reconcile','newLink'].includes(displayStatus)||displayStatus==='registration'&&invite?.delivery==='failed'};
 });
 const renewals=orders.filter(order=>order.channel==='renewal').map(order=>({
  id:order.id,email:order.email,at:order.created_at,type:'renewal',tariff:order.tariff,priceMinor:order.price_minor,
  status:order.status==='reconcile'?'reconcile':order.status==='paid'?'renewed':order.status==='cancelled'?'failed':'pay',
  paymentId:order.id,previousEnd:order.previous_end,accessEnd:order.access_end,attention:order.status==='reconcile'
 }));
 const deletions=(await deletionQueue(db)).requests.map(row=>({id:row.id,email:row.email,at:row.requestedAt,type:'deletion',status:'decision',attention:true}));
 return {requests:[...first,...renewals,...deletions].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))};
}
