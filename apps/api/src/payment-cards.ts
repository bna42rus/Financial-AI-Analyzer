import type {PoolClient} from 'pg';
import type {Sealer} from './types.ts';
import {HttpError} from './types.ts';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import type {AccessPayment} from './access-payment-provider.ts';
export type StoredCard={id:string;user_id:string;method_id:string;last4:string|null;brand:string|null;active:boolean};
export async function cardLock(db:PoolClient,userId:string){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-cycle:'+userId]);}
export async function savedCard(db:PoolClient,userId:string,id:unknown){const card=(await db.query<StoredCard>('SELECT * FROM commerce.payment_card WHERE user_id=$1 AND id=$2 AND active',[userId,uuid(id)])).rows[0];if(!card)throw new HttpError(409,'CARD_UNAVAILABLE');return card;}
export async function paymentCards(db:PoolClient,userId:string,seal?:Sealer){
 if(seal){await cardLock(db,userId);const rows=(await db.query<StoredCard>('SELECT * FROM commerce.payment_card WHERE user_id=$1 AND active ORDER BY created_at,id',[userId])).rows,r=(await db.query('SELECT card_id FROM commerce.autorenewal WHERE user_id=$1',[userId])).rows[0];
  const groups=new Map<string,StoredCard[]>();for(const c of rows){const key=seal.open(c.method_id);groups.set(key,[...(groups.get(key)??[]),c]);}
  for(const group of groups.values()){if(group.length<2)continue;const keep=group.find(c=>c.id===r?.card_id)??group[0]!;for(const c of group){if(c.id===keep.id)continue;for(const table of ['autorenewal','access_checkout','ai_topup_order'])await db.query('UPDATE commerce.'+table+' SET card_id=$3 WHERE user_id=$1 AND card_id=$2',[userId,c.id,keep.id]);await db.query('UPDATE commerce.payment_card SET active=false WHERE user_id=$1 AND id=$2',[userId,c.id]);}}
 }
 return (await db.query(`SELECT c.id,c.last4,c.brand,c.created_at AS "createdAt",COALESCE(r.state='active' AND r.card_id=c.id,false) AS "forRenewal" FROM commerce.payment_card c LEFT JOIN commerce.autorenewal r ON r.user_id=c.user_id WHERE c.user_id=$1 AND c.active ORDER BY c.created_at,c.id`,[userId])).rows;
}
export async function saveCard(db:PoolClient,userId:string,p:AccessPayment,seal:Sealer){
 const m=p.payment_method;if(!m?.saved||typeof m.id!=='string'||!m.id||m.id.length>160)return null;await cardLock(db,userId);
 const old=(await db.query<StoredCard>('SELECT * FROM commerce.payment_card WHERE user_id=$1 ORDER BY active DESC,created_at',[userId])).rows.find(c=>seal.open(c.method_id)===m.id);if(old&&!old.active)return null;
 const method=seal.seal(m.id),last4=/^\d{4}$/.test(m.card?.last4??'')?m.card!.last4:null,brand=typeof m.card?.card_type==='string'?m.card.card_type.slice(0,40):null;
 if(old)await db.query('UPDATE commerce.payment_card SET method_id=$2,last4=COALESCE($3,last4),brand=COALESCE($4,brand),updated_at=clock_timestamp() WHERE id=$1',[old.id,method,last4,brand]);else await db.query('INSERT INTO commerce.payment_card(user_id,method_id,last4,brand) VALUES($1,$2,$3,$4)',[userId,method,last4,brand]);
 await db.query('INSERT INTO commerce.saved_card(user_id,method_id,last4) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET method_id=EXCLUDED.method_id,last4=EXCLUDED.last4,updated_at=clock_timestamp()',[userId,method,last4]);return method;
}
export async function removePaymentCard(db:PoolClient,userId:string,input:unknown){
 const b=object(input,['id','disableRenewal']);await cardLock(db,userId);const card=await savedCard(db,userId,b.id),r=(await db.query('SELECT * FROM commerce.autorenewal WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
 if((await db.query("SELECT 1 FROM commerce.access_checkout WHERE user_id=$1 AND (card_id=$2 OR payment_method_id=$3) AND state IN ('created','pending','reconcile') UNION ALL SELECT 1 FROM commerce.ai_topup_order WHERE user_id=$1 AND card_id=$2 AND status IN ('created','pending')",[userId,card.id,card.method_id])).rowCount)throw new HttpError(409,'CARD_PAYMENT_PENDING');
 if(r?.card_id===card.id&&r.state==='active'&&b.disableRenewal!==true)throw new HttpError(409,'CARD_USED_FOR_RENEWAL');
 if(r?.card_id===card.id){await db.query("UPDATE commerce.autorenewal SET state='off',method_id=NULL,card_id=NULL,notice_id=NULL WHERE user_id=$1",[userId]);if(r.state==='active')await db.query("INSERT INTO commerce.autorenewal_event(user_id,action,checkout_id,tariff,offer_version,renewal_version) VALUES($1,'disable',$2,$3,$4,$5)",[userId,r.checkout_id,r.tariff,r.offer_version,r.renewal_version]);}
 await db.query('UPDATE commerce.payment_card SET active=false,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,card.id]);return {status:'removed'};
}
