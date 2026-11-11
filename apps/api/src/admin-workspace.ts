import type {PoolClient} from 'pg';
import {actionId,remember} from './commerce.ts';
import {deletionQueue} from './account-deletion.ts';
import {HttpError,outbox,string} from './types.ts';
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

export async function adminRequests(db:PoolClient,_target?:string){
 return {requests:(await deletionQueue(db)).requests.map(row=>({id:row.id,email:row.email,at:row.requestedAt,type:'deletion',status:'decision',attention:true}))};
}
