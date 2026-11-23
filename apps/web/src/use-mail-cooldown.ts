import {useEffect,useState} from 'react';

export type MailSend={retryAfterSeconds?:number};
export const mailAddressKey=(address:string)=>address.trim().toLowerCase();
export function mailWait(seconds:number){
 if(seconds>=3600)return 'Повторить через 1 ч';
 const minutes=Math.floor(seconds/60),remainder=seconds%60;
 return minutes?'Повторить через '+minutes+' мин '+String(remainder).padStart(2,'0')+' с':'Повторить через '+remainder+' с';
}
export function useMailCooldown(key=''){
 const [entry,setEntry]=useState<{key:string;until:number}|null>(null),[now,setNow]=useState(Date.now);
 useEffect(()=>{
  if(!entry||entry.until<=Date.now()){setNow(Date.now());return;}
  const id=window.setInterval(()=>{const time=Date.now();setNow(time);if(time>=entry.until)window.clearInterval(id);},250);
  return ()=>window.clearInterval(id);
 },[entry]);
 const seconds=entry?.key===key?Math.max(0,Math.ceil((entry.until-now)/1000)):0;
 function remember(response:unknown,forKey=key){
  if(!response||typeof response!=='object'||!('retryAfterSeconds' in response))return;
  const delay=response.retryAfterSeconds;
  if(typeof delay!=='number'||!Number.isSafeInteger(delay)||delay<1||delay>3600)return;
  const time=Date.now();setNow(time);setEntry({key:forKey,until:time+delay*1000});
 }
 return {seconds,remember,label:seconds?mailWait(seconds):undefined};
}
