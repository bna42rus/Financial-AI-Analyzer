import type {PoolClient} from 'pg';
import type {AssistantProvider} from './analyzer-assistant-provider.ts';
/** Authorize real customer entitlements without replacing access or cost admission. */
export async function analyzerAccess(db:PoolClient,userId:string,email:string,provider:AssistantProvider){
 if(provider.allowed(email))return true;
 return !!(await db.query(`SELECT 1 FROM commerce.access_cycle c JOIN identity.security_state s USING(user_id) WHERE c.user_id=$1 AND s.status='active' AND (c.indefinite OR c.access_end>clock_timestamp()) AND (
 EXISTS(SELECT 1 FROM commerce.access_checkout o WHERE o.user_id=c.user_id AND o.state='paid' AND (o.purpose='access' OR EXISTS(SELECT 1 FROM commerce.trial_checkout t WHERE t.checkout_id=o.id AND t.kind='trial' AND t.result='granted')))
 OR EXISTS(SELECT 1 FROM commerce.purchase p WHERE p.user_id=c.user_id AND p.state='active') OR EXISTS(SELECT 1 FROM commerce.manual_grant g WHERE g.user_id=c.user_id AND g.state='active'))`,[userId])).rowCount;
}
