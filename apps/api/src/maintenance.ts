import type {Pool,PoolClient} from 'pg';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {maintenancePhase} from '../../../packages/access/src/maintenance.ts';
import type {Maintenance} from '../../../packages/access/src/maintenance.ts';
import {HttpError} from './types.ts';
type Reader=Pick<Pool|PoolClient,'query'>;
export async function maintenanceStatus(db:Reader,lock=false):Promise<Maintenance>{
 const row=(await db.query('SELECT *,clock_timestamp() AS now FROM commerce.maintenance WHERE id=true'+(lock?' FOR UPDATE':''))).rows[0];
 const iso=(v:Date|null)=>v?.toISOString()??null,now=row.now.toISOString(),startsAt=iso(row.starts_at);
 return {revision:row.revision,state:row.state,phase:maintenancePhase(row.state,startsAt,now),title:row.title,message:row.message,startsAt,endsAt:iso(row.ends_at),updatedAt:row.updated_at.toISOString(),now};
}
export async function changeMaintenance(db:PoolClient,actor:string,input:unknown){
 const b=object(input,['id','revision','action','title','message','startsAt','endsAt']),id=uuid(b.id);
 if(!Number.isSafeInteger(b.revision)||!['schedule','update','start','finish','cancel'].includes(String(b.action)))throw new HttpError(400,'INVALID_INPUT');
 const old=await maintenanceStatus(db,true),prior=(await db.query('SELECT payload FROM commerce.maintenance_event WHERE id=$1',[id])).rows[0];
 if(prior){const keys=['revision','action','title','message','startsAt','endsAt'];if(keys.some(k=>JSON.stringify(prior.payload.command[k])!==JSON.stringify(b[k])))throw new HttpError(409,'ACTION_REUSED');return old;}
 if(b.revision!==old.revision)throw new HttpError(409,'ACTION_CONFLICT');
 let state=old.state,title=old.title,message=old.message,starts=old.startsAt,ends=old.endsAt;
 if(b.action==='cancel'){if(old.phase!=='scheduled')throw new HttpError(409,'ACTION_CONFLICT');state='cancelled';}
 else if(b.action==='finish'){if(old.phase!=='active')throw new HttpError(409,'ACTION_CONFLICT');state='completed';}
 else{
  if(typeof b.title!=='string'||!b.title.trim()||b.title.length>100||typeof b.message!=='string'||b.message.length>1000)throw new HttpError(400,'INVALID_INPUT');
  if(b.action==='schedule'&&['scheduled','active'].includes(old.phase)||b.action==='update'&&!['scheduled','active'].includes(old.phase)||b.action==='start'&&old.phase==='active')throw new HttpError(409,'ACTION_CONFLICT');
  const date=(v:unknown)=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)||!Number.isFinite(Date.parse(v)))throw new HttpError(400,'INVALID_INPUT');const canonical=new Date(v).toISOString();if(canonical!==(v.includes('.')?v:v.replace('Z','.000Z')))throw new HttpError(400,'INVALID_INPUT');return canonical;};
  starts=b.action==='start'?old.now:date(b.startsAt);ends=date(b.endsAt);
  if(Date.parse(ends)<=Math.max(Date.parse(starts),Date.parse(old.now))||b.action==='schedule'&&starts<old.now||b.action==='update'&&old.phase==='active'&&starts!==old.startsAt)throw new HttpError(400,'INVALID_INPUT');
  state='scheduled';title=b.title.trim();message=b.message.trim();
 }
 await db.query('UPDATE commerce.maintenance SET revision=revision+1,state=$1,title=$2,message=$3,starts_at=$4,ends_at=$5,updated_at=clock_timestamp() WHERE id=true',[state,title,message,starts,ends]);
 const next=await maintenanceStatus(db),payload={command:b,before:old,after:next};
 await db.query('INSERT INTO commerce.maintenance_event(id,revision,actor_id,payload) VALUES($1,$2,$3,$4)',[id,next.revision,actor,payload]);
 const phaseNames={none:'Нет работ',scheduled:'Запланированы',active:'Идут',completed:'Завершены',cancelled:'Отменены'};
 const changes=[{label:'Состояние',before:phaseNames[old.phase],after:phaseNames[next.phase]},{label:'Заголовок',before:old.title,after:title},{label:'Начало работ',before:old.startsAt,after:starts},{label:'Окончание работ',before:old.endsAt,after:ends}].filter(c=>c.before!==c.after);
 await db.query('INSERT INTO commerce.action(id,actor_id,payload) VALUES($1,$2,$3)',[id,actor,{kind:'maintenance',decision:'maintenance_'+b.action,reason:message,changes}]);
 return next;
}
