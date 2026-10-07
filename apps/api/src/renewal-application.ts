import type {PoolClient} from 'pg';
import type {FastifyRequest} from 'fastify';
import {claimPayment,emptyAccessStore} from '@finance/access';
import type {AccessRequest,Tariff,AccessStore} from '@finance/access';
import type {RenewalRow,OwnRenewal} from '../../../packages/access/src/renewal.ts';
import {lockedCycle} from './entitlement.ts';
import {clock,fields,string,HttpError,outbox} from './types.ts';
import type {Sealer} from './types.ts';
type User={id:string;name:string;email:string};
export function publicRenewal(data:AccessRequest,state:RenewalRow['renewalState']):RenewalRow {
 const {decisionNote,...rest}=data;
 return {...rest,decisionNote:state==='rejected'?'Обратитесь в поддержку по вопросу оплаты.':'',renewalState:state};
}
function validTariff(value:unknown):value is Tariff {
 if(!value||typeof value!=='object')return false;const t=value as Tariff;
 return typeof t.id==='string'&&t.id.length>0&&t.id.length<=100&&typeof t.name==='string'&&t.name.trim().length>0&&t.name.length<=100
  &&typeof t.priceMinor==='string'&&/^[1-9]\d*$/.test(t.priceMinor)&&t.priceMinor.length<=19&&BigInt(t.priceMinor)<=9223372036854775807n
  &&!!t.duration&&['days','calendar_months'].includes(t.duration.kind)&&Number.isInteger(t.duration.count)&&t.duration.count>=1&&t.duration.count<=36500
  &&Number.isSafeInteger(t.aiQuota)&&t.aiQuota>=0&&t.active===true&&t.availableForRenewal===true&&typeof t.publicVisible==='boolean'&&typeof t.availableForNew==='boolean';
}
async function tariffs(db:PoolClient):Promise<Tariff[]> {return (await db.query(`SELECT snapshot FROM access.tariff WHERE snapshot->>'active'='true' AND snapshot->>'availableForRenewal'='true' ORDER BY id`)).rows.map(r=>r.snapshot).filter(validTariff);}
export async function ownRenewal(db:PoolClient,userId:string):Promise<OwnRenewal>{
 const cycle=await lockedCycle(db,userId),row=(await db.query(`SELECT data,state FROM commerce.renewal_request WHERE user_id=$1 ORDER BY (state='open') DESC,created_at DESC,id DESC LIMIT 1`,[userId])).rows[0];
 return {cycle,request:row?publicRenewal(row.data,row.state):null,tariffs:await tariffs(db)};
}
async function snapshot(db:PoolClient,id:unknown){const tariff=(await tariffs(db)).find(t=>t.id===string(id,100));if(!tariff)throw new HttpError(409,'TARIFF_UNAVAILABLE');return tariff;}
export async function renewalApplication(db:PoolClient,request:FastifyRequest,user:User,seal:Sealer,action:'create'|'change'|'cancel'|'claim'){
 const b=fields(request,action==='create'?['tariffId']:action==='change'?['requestId','expectedRevision','tariffId']:action==='cancel'?['requestId','expectedRevision']:['requestId','expectedRevision','senderName','senderBank']);
 await lockedCycle(db,user.id);
 const row=(await db.query(`SELECT * FROM commerce.renewal_request WHERE user_id=$1 AND state='open' FOR UPDATE`,[user.id])).rows[0];
 const now=await clock(db);
 if(action==='create'){
   if(row)throw new HttpError(409,'RENEWAL_CONFLICT');
   const tariff=await snapshot(db,b.tariffId);
   const data:AccessRequest={id:crypto.randomUUID(),revision:0,kind:'renewal',name:user.name,email:user.email,tariff,status:'awaiting_payment',createdAt:now,expiresAt:now,verifiedAt:now,claimedAt:null,senderName:'',senderBank:'',decisionNote:''};
   // PDF 39 specifies no automatic expiry for a renewal. The domain kind ignores the first-access deadline.
   await db.query(`INSERT INTO commerce.renewal_request(id,user_id,data,review_state,state,created_at) VALUES($1,$2,$3,$4,'open',$5)`,[data.id,user.id,data,{...emptyAccessStore(),requests:[data]},now]);
 }else{
   if(!row||row.id!==string(b.requestId,100)||!Number.isSafeInteger(b.expectedRevision)||row.data.revision!==b.expectedRevision)throw new HttpError(409,'RENEWAL_CONFLICT');
   let data=row.data as AccessRequest,store=row.review_state as AccessStore,state='open';
   if(action==='claim'){
     try{store=claimPayment({...store,requests:[data]},data.id,{name:string(b.senderName,100),bank:string(b.senderBank,100)},now);}catch{throw new HttpError(409,'RENEWAL_CONFLICT');}
     data=store.requests[0]!;
     await outbox(db,'access',seal,'renewal_claim',{email:user.email,name:user.name,senderName:data.senderName,senderBank:data.senderBank,expectedMinor:data.tariff.priceMinor,tariff:data.tariff,createdAt:data.createdAt,claimedAt:data.claimedAt,lastClaimedAt:data.lastClaimedAt});
   }else{
     if(data.claimedAt||data.status!=='awaiting_payment')throw new HttpError(409,'RENEWAL_FROZEN');
     data={...data,revision:data.revision+1,...(action==='change'?{tariff:await snapshot(db,b.tariffId)}:{})};
     if(action==='cancel')state='cancelled';store={...store,requests:[data]};
   }
   await db.query('UPDATE commerce.renewal_request SET data=$1,review_state=$2,state=$3 WHERE id=$4',[data,store,state,row.id]);
 }
 return ownRenewal(db,user.id);
}
