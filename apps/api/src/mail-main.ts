import {Pool} from 'pg';
import {startMailWorker} from './mail-worker.ts';
import type {MailProfile} from './mail-worker.ts';
import {runtimeKey,stagingDatabase} from './runtime-key.ts';
import {privateJson} from './kms.ts';
import {join} from 'node:path';
import type {PostboxConfig} from './postbox.ts';
const environment=process.env.APP_ENV,transport=process.env.MAIL_TRANSPORT;
if(!['development','staging'].includes(environment??'')||!['sandbox','postbox'].includes(transport??'')||transport==='postbox'&&environment!=='staging')throw new Error('MAIL_CONFIGURATION_DENIED');
const profile=process.env.MAIL_PROFILE as MailProfile;
if(!['finance','control'].includes(profile))throw new Error('An explicit mail profile is required');
stagingDatabase(environment,process.env.MAIL_DATABASE_URL);
const url=new URL(process.env.MAIL_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('A local database is required');
const key=await runtimeKey(environment,profile,process.env.MAIL_WRAPPING_KEY,'hex');
let postbox:PostboxConfig|undefined;
if(transport==='postbox'){
 const secret=await privateJson(join(process.env.CREDENTIALS_DIRECTORY!,'postbox.json'));
 if(secret.sender!=='notifications@cashneuro.ru'||typeof secret.username!=='string'||typeof secret.password!=='string')throw new Error('POSTBOX_CONFIGURATION_DENIED');
 postbox={sender:secret.sender,username:secret.username,password:secret.password,environment:'staging',recipients:(process.env.MAIL_TEST_RECIPIENTS??'').split(',').map(v=>v.trim()).filter(Boolean)};
}
const pool=new Pool({connectionString:url.toString()});
const worker=await startMailWorker({profile,pool,wrappingKey:key.bytes,kmsKey:key.kmsKey,environment:environment as 'development'|'staging',postbox,financeOrigin:process.env.FINANCE_ORIGIN??'',controlOrigin:process.env.CONTROL_ORIGIN??'',adminRecipient:process.env.MAIL_ADMIN_RECIPIENT??''});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;try{await worker.stop();await pool.end();}finally{key.destroy();}}
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
