export type Maintenance={revision:number;state:'none'|'scheduled'|'completed'|'cancelled';phase:'none'|'scheduled'|'active'|'completed'|'cancelled';title:string;message:string;startsAt:string|null;endsAt:string|null;updatedAt:string;now:string};
export function maintenancePhase(state:Maintenance['state'],startsAt:string|null,now:string):Maintenance['phase']{return state==='scheduled'&&startsAt&&Date.parse(startsAt)<=Date.parse(now)?'active':state;}
export function maintenanceWarning(m:Maintenance){if(m.phase!=='scheduled'||!m.startsAt)return 0;const hours=(Date.parse(m.startsAt)-Date.parse(m.now))/3600000;return hours<=1?1:hours<=3?3:hours<=24?24:0;}
export function maintenanceBlocks(path:string,method:string){return !(method==='GET'&&(path==='/session'||path==='/health'||path==='/access/maintenance'||path.startsWith('/public/'))||method==='POST'&&path==='/auth/sign-out');}
export function maintenanceNotice(m:Maintenance){
 if(!m.startsAt||!m.endsAt)return '';
 const options={timeZone:'Europe/Moscow'},day=new Intl.DateTimeFormat('en-CA',{...options,year:'numeric',month:'2-digit',day:'2-digit'}),time=new Intl.DateTimeFormat('ru-RU',{...options,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const start=new Date(m.startsAt),end=new Date(m.endsAt),now=new Date(m.now),startDay=day.format(start),today=day.format(now);
 const fullDate=(d:Date)=>new Intl.DateTimeFormat('ru-RU',{...options,day:'numeric',month:'long',...(d.getUTCFullYear()!==now.getUTCFullYear()?{year:'numeric'}:{})}).format(d);
 const prefix=startDay===today?'Сегодня':startDay===day.format(new Date(now.getTime()+86400000))?'Завтра':fullDate(start);
 const finish=time.format(end)+(startDay===day.format(end)?'':' '+fullDate(end));
 return `${prefix} с ${time.format(start)} до ${finish} по МСК сайт будет недоступен — запланированы технические работы.`;
}
