import type {PoolClient} from 'pg';
import type {Sealer} from './types.ts';
import {HttpError} from './types.ts';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import type {AccessPayment,AccessPaymentProvider,PaymentMethod} from './access-payment-provider.ts';
export type StoredCard={id:string;user_id:string;method_id:string;last4:string|null;brand:string|null;active:boolean;created_at?:Date;updated_at?:Date;fingerprint_checked_at?:Date|null;fingerprint?:string|null};
export async function cardLock(db:PoolClient,userId:string){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-cycle:'+userId]);}
export async function savedCard(db:PoolClient,userId:string,id:unknown){const card=(await db.query<StoredCard>('SELECT * FROM commerce.payment_card WHERE user_id=$1 AND id=$2 AND active',[userId,uuid(id)])).rows[0];if(!card)throw new HttpError(409,'CARD_UNAVAILABLE');return card;}
function fingerprint(m:PaymentMethod,seal:Sealer){const c=m.card;if(!c||!/^\d{6}$/.test(c.first6??'')||!/^\d{4}$/.test(c.last4??'')||!/^\d{2}$/.test(c.expiry_month??'')||!/^\d{4}$/.test(c.expiry_year??''))return null;return seal.rateKey('saved-card:'+c.first6+':'+c.last4+':'+c.expiry_month+':'+c.expiry_year);}
async function mergeCard(db:PoolClient,userId:string,remove:string,keep:string){
 for(const table of ['autorenewal','access_checkout','ai_topup_order'])await db.query('UPDATE commerce.'+table+' SET card_id=$3 WHERE user_id=$1 AND card_id=$2',[userId,remove,keep]);
 await db.query('UPDATE commerce.payment_card SET active=false WHERE user_id=$1 AND id=$2',[userId,remove]);
}
export async function paymentCards(db:PoolClient,userId:string,seal?:Sealer,provider?:AccessPaymentProvider){
 if(seal){await cardLock(db,userId);const rows=(await db.query<StoredCard>('SELECT * FROM commerce.payment_card WHERE user_id=$1 AND active ORDER BY created_at,id',[userId])).rows,r=(await db.query('SELECT card_id FROM commerce.autorenewal WHERE user_id=$1',[userId])).rows[0];
  if(provider?.readMethod)await Promise.allSettled(rows.filter(c=>!c.fingerprint&&(!c.fingerprint_checked_at||Date.now()-c.fingerprint_checked_at.getTime()>300000)).slice(0,16).map(async c=>{
   try{const m=await provider.readMethod!(seal.open(c.method_id));c.fingerprint=fingerprint(m,seal);}catch{/* Metadata failure does not hide the card. */}
   await db.query('UPDATE commerce.payment_card SET fingerprint=COALESCE($3,fingerprint),fingerprint_checked_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,c.id,c.fingerprint??null]);
  }));
  const known=new Map(rows.filter(c=>c.fingerprint).map(c=>[seal.open(c.method_id),c.fingerprint!]));
  const groups=new Map<string,StoredCard[]>();for(const c of rows){const key=c.fingerprint??known.get(seal.open(c.method_id))??seal.rateKey('saved-method:'+seal.open(c.method_id));groups.set(key,[...(groups.get(key)??[]),c]);}
  for(const group of groups.values()){if(group.length<2)continue;const keep=group.find(c=>c.id===r?.card_id)??group[0]!;for(const c of group){if(c.id!==keep.id)await mergeCard(db,userId,c.id,keep.id);}const latest=[...group].sort((a,b)=>(b.updated_at?.getTime()??0)-(a.updated_at?.getTime()??0))[0]!;await db.query('UPDATE commerce.payment_card SET method_id=$3,fingerprint=COALESCE($4,fingerprint) WHERE user_id=$1 AND id=$2',[userId,keep.id,latest.method_id,latest.fingerprint??keep.fingerprint??null]);await db.query("UPDATE commerce.autorenewal SET method_id=$3 WHERE user_id=$1 AND card_id=$2 AND state='active'",[userId,keep.id,latest.method_id]);}
 }
 return (await db.query(`SELECT c.id,c.last4,c.brand,c.created_at AS "createdAt",COALESCE(r.state='active' AND r.card_id=c.id,false) AS "forRenewal" FROM commerce.payment_card c LEFT JOIN commerce.autorenewal r ON r.user_id=c.user_id WHERE c.user_id=$1 AND c.active ORDER BY c.created_at,c.id`,[userId])).rows;
}
export async function saveCard(db:PoolClient,userId:string,p:AccessPayment,seal:Sealer){
 const m=p.payment_method;if(!m?.saved||typeof m.id!=='string'||!m.id||m.id.length>160)return null;await cardLock(db,userId);
 const rows=(await db.query<StoredCard>('SELECT * FROM commerce.payment_card WHERE user_id=$1 ORDER BY active DESC,created_at',[userId])).rows,key=fingerprint(m,seal);
 const tokenMatch=rows.find(c=>seal.open(c.method_id)===m.id);if(tokenMatch&&!tokenMatch.active)return null;
 const old=tokenMatch??rows.find(c=>c.active&&key&&c.fingerprint===key);
 const method=seal.seal(m.id),last4=/^\d{4}$/.test(m.card?.last4??'')?m.card!.last4:null,brand=typeof m.card?.card_type==='string'?m.card.card_type.slice(0,40):null;
 if(old){await db.query('UPDATE commerce.payment_card SET method_id=$2,last4=COALESCE($3,last4),brand=COALESCE($4,brand),fingerprint=COALESCE($5,fingerprint),updated_at=clock_timestamp() WHERE id=$1',[old.id,method,last4,brand,key]);await db.query("UPDATE commerce.autorenewal SET method_id=$3 WHERE user_id=$1 AND card_id=$2 AND state='active'",[userId,old.id,method]);}
 else await db.query('INSERT INTO commerce.payment_card(user_id,method_id,last4,brand,fingerprint) VALUES($1,$2,$3,$4,$5)',[userId,method,last4,brand,key]);
 await db.query('INSERT INTO commerce.saved_card(user_id,method_id,last4) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET method_id=EXCLUDED.method_id,last4=EXCLUDED.last4,updated_at=clock_timestamp()',[userId,method,last4]);return method;
}
export async function removePaymentCard(db:PoolClient,userId:string,input:unknown){
 const b=object(input,['id','disableRenewal']);await cardLock(db,userId);const card=await savedCard(db,userId,b.id),r=(await db.query('SELECT * FROM commerce.autorenewal WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
 if((await db.query("SELECT 1 FROM commerce.access_checkout WHERE user_id=$1 AND (card_id=$2 OR payment_method_id=$3) AND state IN ('created','pending','reconcile') UNION ALL SELECT 1 FROM commerce.ai_topup_order WHERE user_id=$1 AND card_id=$2 AND status IN ('created','pending')",[userId,card.id,card.method_id])).rowCount)throw new HttpError(409,'CARD_PAYMENT_PENDING');
 if(r?.card_id===card.id&&r.state==='active'&&b.disableRenewal!==true)throw new HttpError(409,'CARD_USED_FOR_RENEWAL');
 if(r?.card_id===card.id){await db.query("UPDATE commerce.autorenewal SET state='off',method_id=NULL,card_id=NULL,notice_id=NULL WHERE user_id=$1",[userId]);if(r.state==='active')await db.query("INSERT INTO commerce.autorenewal_event(user_id,action,checkout_id,tariff,offer_version,renewal_version) VALUES($1,'disable',$2,$3,$4,$5)",[userId,r.checkout_id,r.tariff,r.offer_version,r.renewal_version]);}
 await db.query('UPDATE commerce.payment_card SET active=false,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,card.id]);return {status:'removed'};
}
