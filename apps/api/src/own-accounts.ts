import type {PoolClient} from 'pg';
import type {PreparedRow} from '../../../packages/imports/src/contract.ts';
export async function ownedPeerAccount(db:PoolClient,userId:string,peers:PreparedRow['transferAccounts']){
 if(!peers?.length)return undefined;
 const rows=(await db.query<{id:string}>(`SELECT DISTINCT COALESCE(c.merged_into_id,c.id) AS id
 FROM jsonb_to_recordset($2::jsonb) AS p(bank text,kind text,hmac text)
 JOIN finance.account_alias a ON a.user_id=$1 AND a.alias_type=p.kind AND a.alias_hmac=p.hmac
 JOIN finance.account c ON (c.user_id,c.id)=(a.user_id,a.account_id) AND c.bank_id=p.bank`,[userId,JSON.stringify(peers)])).rows;
 return rows.length===1?rows[0]!.id:undefined;
}
export async function observationOwnAccounts(db:PoolClient,userId:string){
 const rows=(await db.query<{observation_id:string;account_id:string}>(`SELECT DISTINCT p.observation_id,COALESCE(c.merged_into_id,c.id) AS account_id
 FROM finance.observation_peer_account p JOIN finance.account_alias a ON a.user_id=p.user_id AND a.alias_type=p.alias_type AND a.alias_hmac=p.alias_hmac
 JOIN finance.account c ON (c.user_id,c.id)=(a.user_id,a.account_id) AND c.bank_id=p.bank_id
 WHERE p.user_id=$1`,[userId])).rows;
 const grouped=new Map<string,Set<string>>();for(const row of rows){const ids=grouped.get(row.observation_id)??new Set<string>();ids.add(row.account_id);grouped.set(row.observation_id,ids);}
 return new Map([...grouped].flatMap(([id,ids])=>ids.size===1?[[id,[...ids][0]!] as const]:[]));
}
