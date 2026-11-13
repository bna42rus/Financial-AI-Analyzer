import type {PoolClient} from 'pg';
import type {Cycle,Extension} from '../../../packages/access/src/renewal.ts';
import type {Duration} from '@finance/access';
import {HttpError} from './types.ts';
export function cycleView(row:{anchor_at:Date;access_end:Date|null;timezone:string;revision:number;calendar_months:number;extra_days:number;indefinite?:boolean;end_offset_ms?:string;quota_policy?:Cycle['quotaPolicy']}):Cycle {
 return {anchorAt:row.anchor_at.toISOString(),accessEnd:row.access_end?.toISOString()??null,timezone:row.timezone,revision:row.revision,calendarMonths:row.calendar_months,extraDays:row.extra_days,indefinite:row.indefinite??false,endOffsetMs:Number(row.end_offset_ms??0),...(row.quota_policy?{quotaPolicy:row.quota_policy}:{})};
}
export async function lockedCycle(db:PoolClient,userId:string){
 // SELECT FOR UPDATE would require finance UPDATE privileges over the paid clock.
 // Both profiles instead take the same per-user transaction lock before reading/mutating it.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-cycle:'+userId]);
 const r=(await db.query('SELECT * FROM commerce.access_cycle WHERE user_id=$1',[userId])).rows[0];
 if(!r)throw new HttpError(409,'CYCLE_UNAVAILABLE');return cycleView(r);
}
export async function extensionAt(db:PoolClient,cycle:Cycle,duration:Duration,now:string,requestId:string,actionId:string):Promise<{extension:Extension;calendarMonths:number;extraDays:number}> {
 if(cycle.indefinite||!cycle.accessEnd)throw new HttpError(409,'CYCLE_INDEFINITE');
 if(!['days','calendar_months'].includes(duration.kind)||!Number.isInteger(duration.count)||duration.count<1||duration.count>36500||cycle.timezone!=='Europe/Moscow')throw new HttpError(409,'INVALID_DURATION');
 const continuous=Date.parse(cycle.accessEnd)>Date.parse(now),anchor=continuous?cycle.anchorAt:now;
 const calendarMonths=(continuous?cycle.calendarMonths:0)+(duration.kind==='calendar_months'?duration.count:0);
 const extraDays=(continuous?cycle.extraDays:0)+(duration.kind==='days'?duration.count:0);
 if(calendarMonths>36500||extraDays>36500)throw new HttpError(409,'INVALID_DURATION');
 // The original calendar grid remains intact. Day grants are an explicit cumulative offset,
 // not a reset of the cycle or quota anchor; never add a month to a previously clamped day.
 const finish=(await db.query(`SELECT ((($1::timestamptz AT TIME ZONE $2)+make_interval(months=>$3)) AT TIME ZONE $2)+($4*interval '24 hours')+$5::interval AS finish`,[anchor,cycle.timezone,calendarMonths,extraDays,`${continuous?(cycle.endOffsetMs??0):0} milliseconds`])).rows[0].finish.toISOString();
 if(Date.parse(finish)<=Date.parse(continuous?cycle.accessEnd:now))throw new HttpError(409,'INVALID_DURATION');
 return {calendarMonths,extraDays,extension:{requestId,actionId,at:now,mode:continuous?'continuous':'restored',previousEnd:cycle.accessEnd,accessEnd:finish,anchorAt:anchor,timezone:cycle.timezone,duration}};
}

/** Append the purchased duration while retaining the account's original accounting anchor. */
export async function queuedExtensionAt(db:PoolClient,cycle:Cycle,duration:Duration,now:string,requestId:string,actionId:string){
 const active=!!cycle.accessEnd&&Date.parse(cycle.accessEnd)>Date.parse(now);
 const previous=(await db.query("SELECT kind,allowance_anchor FROM commerce.access_paid_window WHERE user_id=current_setting('app.user_id',true) AND ends_at=$1 ORDER BY starts_at DESC LIMIT 1",[cycle.accessEnd])).rows[0];
 let anchor=active?cycle.accessEnd!:now,months=0;
 if(active&&duration.kind==='calendar_months'&&previous?.kind==='calendar_months'){
  const candidate=previous.allowance_anchor?.toISOString()??(cycle.extraDays===0&&!cycle.endOffsetMs?cycle.anchorAt:null);
  if(candidate){const check=(await db.query("WITH d AS(SELECT $1::timestamptz AT TIME ZONE $3 AS a,$2::timestamptz AT TIME ZONE $3 AS e),n AS(SELECT *,((extract(year FROM e)-extract(year FROM a))*12+extract(month FROM e)-extract(month FROM a))::int AS count FROM d) SELECT count,a+make_interval(months=>count)=e AS exact FROM n",[candidate,cycle.accessEnd,cycle.timezone])).rows[0];if(check?.exact){anchor=candidate;months=check.count;}}
 }
 const periodCycle=active?{...cycle,anchorAt:anchor,calendarMonths:months,extraDays:0,endOffsetMs:0}:cycle;
 const result=await extensionAt(db,periodCycle,duration,now,requestId,actionId),allowanceAnchor=result.extension.anchorAt;
 if(!active)return {...result,allowanceAnchor,endOffsetMs:0};
 const calendarMonths=cycle.calendarMonths+(duration.kind==='calendar_months'?duration.count:0),extraDays=cycle.extraDays+(duration.kind==='days'?duration.count:0);
 if(calendarMonths>36500||extraDays>36500)throw new HttpError(409,'INVALID_DURATION');
 const grid=(await db.query("SELECT (($1::timestamptz AT TIME ZONE $2)+make_interval(months=>$3)) AT TIME ZONE $2 AS base",[cycle.anchorAt,cycle.timezone,calendarMonths])).rows[0].base.getTime()+extraDays*86400000;
 return {...result,calendarMonths,extraDays,allowanceAnchor,endOffsetMs:Date.parse(result.extension.accessEnd)-grid,extension:{...result.extension,anchorAt:cycle.anchorAt}};
}
