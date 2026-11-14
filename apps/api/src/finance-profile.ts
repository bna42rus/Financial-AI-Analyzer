import type {PoolClient} from 'pg';
import {object} from '../../../packages/finance-core/src/model.ts';
import {profileCalendar,AssistantError} from '../../../packages/analyzer/src/assistant-plan.ts';
import {prepareFinance} from './finance.ts';
/** One owner preference for financial calendars, independent of the tariff cycle.
 * Initialize is insert-only with respect to an existing explicit choice. */
export async function financeProfile(db:PoolClient,userId:string,value:unknown){
 const r=object(value,['timezone','initialize','followsDevice','syncDevice']);
 if((r.followsDevice!==undefined&&typeof r.followsDevice!=='boolean')||
  (r.syncDevice!==undefined&&r.syncDevice!==true)||
  ((r.followsDevice!==undefined||r.syncDevice!==undefined)&&(r.timezone===undefined||r.initialize!==undefined))||
  (r.syncDevice&&r.followsDevice!==undefined))throw new TypeError('ASSISTANT_PROFILE_INVALID');
 if(r.initialize!==undefined&&(typeof r.initialize!=='boolean'||r.timezone===undefined))throw new TypeError('ASSISTANT_PROFILE_INVALID');
 await prepareFinance(db,userId);
 if(r.timezone!==undefined){const calendar=profileCalendar(new Date(),r.timezone as string);if(!(await db.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[calendar.timezone])).rowCount)throw new AssistantError('ASSISTANT_TIMEZONE_INVALID');
  if(r.initialize===true||r.syncDevice){
   await db.query('INSERT INTO finance.assistant_profile(user_id,timezone,follows_device) VALUES($1,$2,true) ON CONFLICT(user_id) DO UPDATE SET timezone=EXCLUDED.timezone WHERE $3 AND finance.assistant_profile.follows_device AND finance.assistant_profile.timezone IS DISTINCT FROM EXCLUDED.timezone',[userId,calendar.timezone,r.syncDevice===true]);
  }else await db.query('INSERT INTO finance.assistant_profile(user_id,timezone,follows_device) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET timezone=EXCLUDED.timezone,follows_device=EXCLUDED.follows_device',[userId,calendar.timezone,r.followsDevice===true]);
 }
 return await financialTimezonePreference(db,userId);
}
export async function financialTimezonePreference(db:PoolClient,userId:string):Promise<{timezone:string|null;followsDevice:boolean}>{
 return (await db.query('SELECT timezone,follows_device AS "followsDevice" FROM finance.assistant_profile WHERE user_id=$1',[userId])).rows[0]??{timezone:null,followsDevice:true};
}
export async function financialTimezone(db:PoolClient,userId:string):Promise<string|null>{return (await financialTimezonePreference(db,userId)).timezone;}
