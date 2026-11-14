import {test} from 'node:test';
import assert from 'node:assert/strict';
import {maintenancePhase,maintenanceWarning,maintenanceBlocks,maintenanceNotice} from '../../../packages/access/src/maintenance.ts';
import {changeMaintenance} from '../src/maintenance.ts';
const now='2026-11-14T20:00:00.000Z';
test('start is exact, planned end never automatically opens access, cancellation/completion are final',()=>{
 assert.equal(maintenancePhase('scheduled','2026-11-14T20:00:00.001Z',now),'scheduled');
 assert.equal(maintenancePhase('scheduled',now,now),'active');
 assert.equal(maintenancePhase('scheduled','2020-01-01T00:00:00Z',now),'active');
 for(const s of ['none','cancelled','completed'] as const)assert.equal(maintenancePhase(s,'2020-01-01T00:00:00Z',now),s);
});
test('24/3/1-hour warnings also cover late scheduling',()=>{
 for(const [hours,expected] of [[25,0],[24,24],[4,24],[3,3],[1,1],[.1,1]] as const)assert.equal(maintenanceWarning({phase:'scheduled',now,startsAt:new Date(Date.parse(now)+hours*3600000).toISOString()} as any),expected);
});
test('finance reads and purchases are closed; status/session/sign-out remain reachable',()=>{
 for(const [p,m] of [['/finance/overview','POST'],['/access/billing-create','POST'],['/access/billing','GET'],['/auth/sign-in/email','POST']] as const)assert.equal(maintenanceBlocks(p,m),true);
 for(const [p,m] of [['/session','GET'],['/public/maintenance','GET'],['/access/maintenance','GET'],['/health','GET'],['/auth/sign-out','POST']] as const)assert.equal(maintenanceBlocks(p,m),false);
});
function fixture(){
 const row={revision:0,state:'none',title:'Обновляем CashNeuro',message:'',starts_at:null as Date|null,ends_at:null as Date|null,updated_at:new Date(now),now:new Date(now)},events=new Map<string,any>(),actions:any[]=[];
 const db={query:async(sql:string,v:any[]=[])=>{
  if(sql.startsWith('SELECT *,clock_timestamp'))return {rows:[{...row}]};
  if(sql.startsWith('SELECT payload'))return {rows:events.has(v[0])?[{payload:events.get(v[0])}]:[]};
  if(sql.startsWith('UPDATE commerce.maintenance')){row.revision++;[row.state,row.title,row.message]=v;row.starts_at=v[3]?new Date(v[3]):null;row.ends_at=v[4]?new Date(v[4]):null;}
  else if(sql.startsWith('INSERT INTO commerce.maintenance_event'))events.set(v[0],v[3]);
  else if(sql.startsWith('INSERT INTO commerce.action'))actions.push(v);
  else throw Error('Unexpected SQL');return {rows:[]};
 }} as any;return {db,row,actions};
}
const command={id:'12345678-1234-4234-a234-123456789abc',revision:0,action:'schedule',title:'Плановые работы',message:'Обновляем сервис',startsAt:'2026-11-14T21:00:00.000Z',endsAt:'2026-11-14T22:00:00.000Z'};
test('schedule is audited, retries do not duplicate it, concurrent/stale edits cannot overwrite',async()=>{
 const f=fixture();assert.equal((await changeMaintenance(f.db,'admin',command)).phase,'scheduled');assert.equal(f.actions.length,1);
 await changeMaintenance(f.db,'admin',command);assert.equal(f.row.revision,1);
 await assert.rejects(changeMaintenance(f.db,'admin',{...command,message:'different'}),{code:'ACTION_REUSED'});
 await assert.rejects(changeMaintenance(f.db,'admin',{...command,id:'22345678-1234-4234-a234-123456789abc'}),{code:'ACTION_CONFLICT'});
});
test('start, overrun and extension keep access closed until manual finish',async()=>{
 const f=fixture();assert.equal((await changeMaintenance(f.db,'admin',{...command,action:'start'})).phase,'active');
 f.row.now=new Date('2026-11-14T23:00:00Z');
 assert.equal((await changeMaintenance(f.db,'admin',{...command,id:'22345678-1234-4234-a234-123456789abc',revision:1,action:'update',startsAt:now,endsAt:'2026-11-15T01:00:00.000Z'})).phase,'active');
 assert.equal((await changeMaintenance(f.db,'admin',{id:'32345678-1234-4234-a234-123456789abc',revision:2,action:'finish'})).phase,'completed');
});
test('bad dates and cancelling active work are rejected',async()=>{
 const f=fixture();await assert.rejects(changeMaintenance(f.db,'admin',{...command,endsAt:now}),{code:'INVALID_INPUT'});
 await assert.rejects(changeMaintenance(f.db,'admin',{...command,endsAt:'2026-02-30T22:00:00.000Z'}),{code:'INVALID_INPUT'});
 await changeMaintenance(f.db,'admin',{...command,action:'start'});
 await assert.rejects(changeMaintenance(f.db,'admin',{id:'22345678-1234-4234-a234-123456789abc',revision:1,action:'cancel'}),{code:'ACTION_CONFLICT'});
});

test('notice uses Moscow start day and clear timezone wording, even across midnight',()=>{
 const base={now:'2026-11-14T18:00:00.000Z',startsAt:'2026-11-14T19:19:00.000Z',endsAt:'2026-11-14T20:12:00.000Z'} as any;
 assert.equal(maintenanceNotice(base),'Сегодня с 22:19 до 23:12 по МСК сайт будет недоступен — запланированы технические работы.');
 assert.match(maintenanceNotice({...base,endsAt:'2026-11-15T20:12:00.000Z'}),/^Сегодня с 22:19 до 23:12 15 ноября по МСК/);
 assert.match(maintenanceNotice({...base,startsAt:'2026-11-15T19:19:00.000Z',endsAt:'2026-11-15T20:12:00.000Z'}),/^Завтра с/);
 assert.match(maintenanceNotice({...base,now:'2026-11-14T21:30:00.000Z',startsAt:'2026-11-14T22:00:00.000Z',endsAt:'2026-11-14T23:00:00.000Z'}),/^Сегодня с 01:00/);
});
