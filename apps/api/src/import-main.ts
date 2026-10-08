import {Pool} from 'pg';
import {setTimeout} from 'node:timers/promises';
import {runImportStage} from './import-ingestion.ts';

if(process.env.APP_ENV!=='development'||process.env.API_PROFILE!=='finance')throw new Error('Import worker requires the Development Finance profile');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
const role=(await pool.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
if(role.name!=='finance_api'||role.rolsuper||role.rolbypassrls)throw new Error('Import worker requires the scoped Finance database role');
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});
try{while(!stopping){try{if(!await runImportStage(pool))await setTimeout(1000);}catch{await setTimeout(1000);}}}finally{await pool.end();}
