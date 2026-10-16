import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
export async function syntheticOperations(db:PoolClient,user:string,count:number,accountId:string,categoryId:string){
 const large=count>1000,started=performance.now();
 if(large){await db.query("SET LOCAL statement_timeout='120s'");console.log(JSON.stringify({syntheticSeed:count,phase:'start'}));}
 const semantics={kind:{value:'purchase',source:'bank',confidence:100,userVerified:false},role:{value:'expense',source:'user',confidence:100,userVerified:true},category:{value:categoryId,source:'user',confidence:100,userVerified:true},subcategory:{value:null,source:'user',confidence:100,userVerified:true},merchant:{value:'Synthetic paged shop',source:'bank',confidence:100,userVerified:false},counterparty:{value:null,source:'bank',confidence:100,userVerified:false}};
 const pairs=Array.from({length:count},(_,i)=>({id:randomUUID(),observation:randomUUID(),ordinal:i}));
 await db.query(`INSERT INTO finance.transaction(user_id,id,source_observation_id,semantics) SELECT $1,p.id,p.observation,$3::jsonb FROM jsonb_to_recordset($2::jsonb) AS p(id uuid,observation uuid,ordinal int)`,[user,JSON.stringify(pairs),JSON.stringify(semantics)]);
 if(large)console.log(JSON.stringify({syntheticSeed:count,phase:'transactions',elapsedMs:Math.round(performance.now()-started)}));
 await db.query(`INSERT INTO finance.source_observation(user_id,id,transaction_id,account_id,operation_date,posted_date,amount_minor,currency,source_kind,merchant_text,description,bank_category,versions) SELECT $1,p.observation,p.id,$3,jsonb_build_object('precision','day','date','2026-09-02'),jsonb_build_object('precision','day','date','2026-09-03'),-12345,'RUB','purchase','Synthetic paged shop','Synthetic safe source','Synthetic source category','{"parser":"test","normalizer":"test","sanitizer":"test"}'::jsonb FROM jsonb_to_recordset($2::jsonb) AS p(id uuid,observation uuid,ordinal int)`,[user,JSON.stringify(pairs),accountId]);
 // Earlier small fixtures may cache sequential-scan FK plans in this session.
 // Re-plan after bulk growth, keeping RLS, constraints and all rows enabled.
 // PLANS does not reset tenant GUCs/locks/data (unlike DISCARD ALL).
 if(large){console.log(JSON.stringify({syntheticSeed:count,phase:'observations',elapsedMs:Math.round(performance.now()-started)}));await db.query('DISCARD PLANS');}
 await db.query(`INSERT INTO finance.observation_account(user_id,observation_id,account_id) SELECT $1,p.observation,$3 FROM jsonb_to_recordset($2::jsonb) AS p(id uuid,observation uuid,ordinal int)`,[user,JSON.stringify(pairs),accountId]);await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[user]);
 if(large){await db.query('DISCARD PLANS');console.log(JSON.stringify({syntheticSeed:count,phase:'ready-for-commit',elapsedMs:Math.round(performance.now()-started)}));}
 return pairs.map(p=>p.id);
}
