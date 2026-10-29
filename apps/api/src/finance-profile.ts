import type {PoolClient} from 'pg';
import {object} from '../../../packages/finance-core/src/model.ts';
import {profileCalendar,AssistantError} from '../../../packages/analyzer/src/assistant-plan.ts';
import {prepareFinance} from './finance.ts';
/** One owner preference for financial calendars, independent of the tariff cycle.
 * Initialize is insert-only with respect to an existing explicit choice. */
export async function financeProfile(db:PoolClient,userId:string,value:unknown){
 const r=object(value,['timezone','initialize']);
 if(r.initialize!==undefined&&(typeof r.initialize!=='boolean'||r.timezone===undefined))throw new TypeError('ASSISTANT_PROFILE_INVALID');
 await prepareFinance(db,userId);
 if(r.timezone!==undefined){const calendar=profileCalendar(new Date(),r.timezone as string);if(!(await db.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[calendar.timezone])).rowCount)throw new AssistantError('ASSISTANT_TIMEZONE_INVALID');
  if(r.initialize===true)await db.query('INSERT INTO finance.assistant_profile(user_id,timezone) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',[userId,calendar.timezone]);
  else await db.query('INSERT INTO finance.assistant_profile(user_id,timezone) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET timezone=EXCLUDED.timezone',[userId,calendar.timezone]);
 }
 return {timezone:await financialTimezone(db,userId)};
}
export async function financialTimezone(db:PoolClient,userId:string):Promise<string|null>{return (await db.query('SELECT timezone FROM finance.assistant_profile WHERE user_id=$1',[userId])).rows[0]?.timezone??null;}
