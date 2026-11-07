import type {DB,Profile,Sealer} from './types.ts';
import {HttpError} from './types.ts';

const hour=3600;
const limit=6;
type Purpose='application'|'password-reset'|'registration'|'email-change'|'invitation-resend'|'delivery-retry';
type Window={key:string;sends:number;retry_at:Date;expires_at:Date};
export class MailCooldownError extends HttpError {
 constructor(readonly retryAfterSeconds:number){super(429,'MAIL_COOLDOWN');}
}

/** Reserve an accepted send in the same transaction as its token and outbox entry.
 * Public callers reserve before looking up the address to keep responses indistinguishable. */
export async function reserveMailRequest(db:DB,seal:Sealer,scope:Profile,purpose:Purpose,address:string,sender?:string){
 const addressKey=address.trim().toLowerCase();
 const hash=(value:string)=>seal.rateKey('mail-cooldown/v1/'+value);
 const lanes=[hash(purpose+':recipient:'+addressKey),...(sender?[hash(purpose+':sender:'+sender)]:[])];
 // An unauthenticated request must not consume the quota for a verified invitation or email change.
 const audience=purpose==='application'||purpose==='password-reset'?'public':'verified';
 const recipient=purpose==='delivery-retry'?undefined:hash(audience+':all:recipient:'+addressKey);
 const keys=recipient?[...lanes,recipient]:lanes;
 for(const key of [...keys].sort())await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
 const now=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
 const windows=(await db.query<Window>('SELECT key,sends,retry_at,expires_at FROM mail.request_cooldown WHERE scope=$1 AND key=ANY($2::text[]) AND expires_at>$3',[scope,keys,now])).rows;
 const previous=new Map(windows.map(w=>[w.key,w]));
 const all=recipient?previous.get(recipient):undefined;
 const remaining=(until?:Date)=>Math.max(0,Math.ceil(((until?.getTime()??0)-now.getTime())/1000));
 const wait=Math.max(...lanes.map(key=>remaining(previous.get(key)?.retry_at)),all&&all.sends>=limit?remaining(all.expires_at):0);
 if(wait)throw new MailCooldownError(wait);
 const after=(seconds:number)=>new Date(now.getTime()+seconds*1000);
 const upsert=async(key:string,sends:number,retryAt:Date,expiresAt:Date)=>{
  await db.query(`INSERT INTO mail.request_cooldown(scope,key,sends,retry_at,expires_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(scope,key) DO UPDATE SET sends=EXCLUDED.sends,retry_at=EXCLUDED.retry_at,expires_at=EXCLUDED.expires_at`,[scope,key,sends,retryAt,expiresAt]);
 };
 let next=0;
 for(const key of lanes){
  const sends=Math.min(3,(previous.get(key)?.sends??0)+1),delay=sends===1?30:sends===2?60:hour;
  await upsert(key,sends,after(delay),after(hour));
  next=Math.max(next,delay);
 }
 if(recipient){
  const sends=(all?.sends??0)+1,expiresAt=all?.expires_at??after(hour);
  await upsert(recipient,sends,now,expiresAt);
  if(sends===limit)next=Math.max(next,remaining(expiresAt));
 }
 // Bounded opportunistic cleanup of expired pseudonymous keys.
 await db.query(`WITH stale AS (SELECT key FROM mail.request_cooldown WHERE scope=$1 AND expires_at<=$2
   ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED)
   DELETE FROM mail.request_cooldown r USING stale WHERE r.scope=$1 AND r.key=stale.key`,[scope,now]);
 return next;
}
