import {Pool} from 'pg';
import {startMailWorker} from './mail-worker.ts';
import type {MailProfile} from './mail-worker.ts';
if(process.env.APP_ENV!=='development'||process.env.MAIL_TRANSPORT!=='sandbox')throw new Error('Only Development sandbox delivery is supported');
const profile=process.env.MAIL_PROFILE as MailProfile;
if(!['finance','control'].includes(profile))throw new Error('An explicit mail profile is required');
const url=new URL(process.env.MAIL_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('A local Development database is required');
const pool=new Pool({connectionString:url.toString()}),key=Buffer.from(process.env.MAIL_WRAPPING_KEY??'','hex');
const worker=await startMailWorker({profile,pool,wrappingKey:key,environment:'development',financeOrigin:process.env.FINANCE_ORIGIN??'',controlOrigin:process.env.CONTROL_ORIGIN??'',adminRecipient:process.env.MAIL_ADMIN_RECIPIENT??''});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await worker.stop();await pool.end();}
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
