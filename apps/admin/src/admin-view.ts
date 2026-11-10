import {createContext,useContext,useEffect,useState} from 'react';
import {api} from '../../web/src/server-client';
import {deviceZone,timezoneLabel} from '../../web/src/InterfaceSettings';

export type AdminLocation={tab:string;id?:string;search?:string};
export const adminTabs=['users','requests','payments','tariffs','invitations','deliveries','history','account'];
export function readAdminLocation():AdminLocation{
 const [raw,query]=location.hash.slice(1).split('?'),params=new URLSearchParams(query);
 const tab=raw==='manual'?'users':raw==='renewals'?'requests':adminTabs.includes(raw??'')?raw!:'users';
 return {tab,id:params.get('id')??undefined,search:params.get('search')??undefined};
}
export function adminLink(tab:string,query?:{id?:string;search?:string}){
 const params=new URLSearchParams();
 if(query?.id)params.set('id',query.id);
 if(query?.search)params.set('search',query.search);
 return '#'+tab+(params.size?'?'+params:'');
}
const Timezone=createContext('device');
export const AdminTimezoneProvider=Timezone.Provider;
export function useAdminTime(){
 const preference=useContext(Timezone),zone=preference==='device'?deviceZone():preference;
 return {zone,label:timezoneLabel(zone),format:(value:string|null|undefined)=>value?new Intl.DateTimeFormat('ru-RU',{
  timeZone:zone,day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'
 }).format(new Date(value)):'—'};
}
function dateParts(timestamp:number,zone:string){
 const entries=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(timestamp));
 return Object.fromEntries(entries.map(part=>[part.type,part.value]));
}
export function localAdminDate(timestamp:number,zone:string){
 const p=dateParts(timestamp,zone);
 return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute;
}
export function parseAdminDate(value:string,zone:string){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw Error('Укажите дату и время до минуты.');
 const target=Date.parse(value+':00Z');
 if(!Number.isFinite(target)||new Date(target).toISOString().slice(0,16)!==value)throw Error('Проверьте дату и время.');
 const offsets=new Set([-2,0,2].map(days=>{
  const sample=target+days*86400000;
  return Date.parse(localAdminDate(sample,zone)+':00Z')-sample;
 }));
 const possible=[...offsets].map(offset=>target-offset).filter(timestamp=>localAdminDate(timestamp,zone)===value);
 if(possible.length!==1)throw Error(possible.length?'В выбранной зоне это время повторяется при переводе часов. Выберите другое время.':'Такого времени в выбранной зоне нет. Проверьте перевод часов.');
 return new Date(possible[0]!).toISOString();
}
export function useAdminData<T>(endpoint:string,refresh:number){
 const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();
  setLoading(true);setError('');
  void api<T>(endpoint,undefined,controller.signal).then(result=>{if(!controller.signal.aborted)setData(result);})
   .catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Не удалось загрузить данные.');})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[endpoint,refresh,retry]);
 return {data,setData,error,loading,reload:()=>setRetry(n=>n+1)};
}
