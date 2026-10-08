import {PgBoss,getConstructionPlans} from 'pg-boss';
import type {DB} from './types.ts';

/** Operator transaction only: queue schema/tables are never owned by runtime roles. */
export async function installMailQueues(db:DB){
 for(const profile of ['finance','control'] as const){
  const schema='jobs_mail_'+profile;
  const plan=getConstructionPlans(schema).replace(/^\s*BEGIN;/,'').replace(/COMMIT;\s*$/,'');
  await db.query(plan);
  const boss=new PgBoss({schema,db:{executeSql:(sql,values)=>db.query(sql,values)},migrate:false,supervise:false,schedule:false,registerInstance:false});
  await boss.start();
  try{await boss.createQueue('mail-tick',{partition:false,retryLimit:3,retryDelay:15,expireInSeconds:120});}finally{await boss.stop();}
  await db.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC;
   GRANT USAGE ON SCHEMA ${schema} TO mail_${profile}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO mail_${profile}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO mail_${profile}`);
 }
}
