import {Pool} from 'pg';
import {setTimeout} from 'node:timers/promises';
import {runImportStage} from './import-ingestion.ts';
import {stagingDatabase} from './runtime-key.ts';

if(!['development','staging'].includes(process.env.APP_ENV??'')||process.env.API_PROFILE!=='finance')throw new Error('Import worker requires the Development or Staging Finance profile');
stagingDatabase(process.env.APP_ENV,process.env.DATABASE_URL);
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
const role=(await pool.query('SELECT oid,current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
if(role.name!=='finance_api'||role.rolsuper||role.rolbypassrls)throw new Error('Import worker requires the scoped Finance database role');
if((await pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (c.relowner=$1 OR n.nspowner=$1) AND n.nspname IN ('identity','control','access','commerce','finance','protected_keys') LIMIT 1`,[role.oid])).rowCount)throw new Error('Import worker must not own application objects');
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});
try{while(!stopping){try{if(!await runImportStage(pool))await setTimeout(1000);}catch{await setTimeout(1000);}}}finally{await pool.end();}
