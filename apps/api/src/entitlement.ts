import type {PoolClient} from 'pg';
import type {Cycle,Extension} from '../../../packages/access/src/renewal.ts';
import type {Duration} from '@finance/access';
import {HttpError} from './types.ts';
export function cycleView(row:{anchor_at:Date;access_end:Date;timezone:string;revision:number;calendar_months:number;extra_days:number}):Cycle {
 return {anchorAt:row.anchor_at.toISOString(),accessEnd:row.access_end.toISOString(),timezone:row.timezone,revision:row.revision,calendarMonths:row.calendar_months,extraDays:row.extra_days};
}
export async function lockedCycle(db:PoolClient,userId:string){
 const r=(await db.query('SELECT * FROM commerce.access_cycle WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
 if(!r)throw new HttpError(409,'CYCLE_UNAVAILABLE');return cycleView(r);
}
export async function extensionAt(db:PoolClient,cycle:Cycle,duration:Duration,now:string,requestId:string,actionId:string):Promise<{extension:Extension;calendarMonths:number;extraDays:number}> {
 if(!['days','calendar_months'].includes(duration.kind)||!Number.isInteger(duration.count)||duration.count<1||duration.count>36500||cycle.timezone!=='Europe/Moscow')throw new HttpError(409,'INVALID_DURATION');
 const continuous=Date.parse(cycle.accessEnd)>Date.parse(now),anchor=continuous?cycle.anchorAt:now;
 const calendarMonths=(continuous?cycle.calendarMonths:0)+(duration.kind==='calendar_months'?duration.count:0);
 const extraDays=(continuous?cycle.extraDays:0)+(duration.kind==='days'?duration.count:0);
 if(calendarMonths>36500||extraDays>36500)throw new HttpError(409,'INVALID_DURATION');
 // The original calendar grid remains intact. Day grants are an explicit cumulative offset,
 // not a reset of the cycle or quota anchor; never add a month to a previously clamped day.
 const finish=(await db.query(`SELECT ((($1::timestamptz AT TIME ZONE $2)+make_interval(months=>$3)) AT TIME ZONE $2)+($4*interval '24 hours') AS finish`,[anchor,cycle.timezone,calendarMonths,extraDays])).rows[0].finish.toISOString();
 if(Date.parse(finish)<=Date.parse(continuous?cycle.accessEnd:now))throw new HttpError(409,'INVALID_DURATION');
 return {calendarMonths,extraDays,extension:{requestId,actionId,at:now,mode:continuous?'continuous':'restored',previousEnd:cycle.accessEnd,accessEnd:finish,anchorAt:anchor,timezone:cycle.timezone,duration}};
}
