import {useEffect,useState} from 'react';
import {api,ApiError} from './server-client';
import {OperationDialog} from './OperationDialog';
import common from './App.module.css';

type Pending={kind:'access'|'topup';id:string};
type Result=Pending&({kind:'access';accessEnd:string}|{kind:'topup';units:number});
const pendingKey='cashneuro-payment-return',shownKey='cashneuro-payment-shown',eventName='cashneuro-payment-confirmed';
const shown=new Set<string>();
function pendingPayment():Pending|null{
 try{const value=JSON.parse(sessionStorage.getItem(pendingKey)??'null');return value&&['access','topup'].includes(value.kind)&&typeof value.id==='string'&&/^[a-f0-9-]{36}$/i.test(value.id)?value:null;}catch{return null;}
}
export function rememberPayment(kind:Pending['kind'],id:string){try{sessionStorage.setItem(pendingKey,JSON.stringify({kind,id}));}catch{/* Payment can proceed without browser storage. */}}
function forgetPayment(id:string){if(pendingPayment()?.id===id)try{sessionStorage.removeItem(pendingKey);}catch{/* Browser storage may be unavailable. */}}
export function confirmPayment(result:Result){
 forgetPayment(result.id);
 if(shown.has(result.id))return;
 try{if(sessionStorage.getItem(shownKey)===result.id)return;sessionStorage.setItem(shownKey,result.id);}catch{/* In-memory deduplication still applies. */}
 shown.add(result.id);
 window.dispatchEvent(new CustomEvent<Result>(eventName,{detail:result}));
}
// Mounted above purchase forms so the receipt survives their closing and access refreshes.
export function usePaymentResult(enabled:boolean,onRefresh:()=>Promise<void>,timezone='Europe/Moscow'){
 const [result,setResult]=useState<Result|null>(null);
 useEffect(()=>{const receive=(event:Event)=>setResult((event as CustomEvent<Result>).detail);window.addEventListener(eventName,receive);return()=>window.removeEventListener(eventName,receive);},[]);
 useEffect(()=>{
  if(!enabled)return;
  const pending=pendingPayment();if(!pending)return;
  const abort=new AbortController();let running=false;
  async function check(){
   if(running||document.visibilityState==='hidden'||!pending)return;
   running=true;
   try{
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(12000)]);
    let receipt:Result|null=null;
    if(pending.kind==='access'){
     const order=await api<{id:string;state:string}>('/access/billing-sync',{id:pending.id},signal);
     if(order.state==='cancelled')forgetPayment(pending.id);
     if(order.state==='paid'){
      const billing=await api<{accessEnd:string|null}>('/access/billing',undefined,signal);
      if(billing.accessEnd)receipt={...pending,kind:'access',accessEnd:billing.accessEnd};
     }
    }else{
     const order=await api<{id:string;status:string;units:number}>('/finance/ai-topup',{id:pending.id},signal);
     if(order.status==='cancelled')forgetPayment(pending.id);
     if(order.status==='paid')receipt={...pending,kind:'topup',units:order.units};
    }
    if(receipt&&!abort.signal.aborted){await onRefresh().catch(()=>{});if(!abort.signal.aborted)confirmPayment(receipt);}
   }catch(e){if(e instanceof ApiError&&['NOT_FOUND','AUTH_REQUIRED'].includes(e.code))forgetPayment(pending.id);}
   finally{running=false;}
  }
  const tick=()=>{if(pendingPayment()?.id===pending.id)void check();};
  tick();const timer=window.setInterval(tick,15000);window.addEventListener('focus',tick);
  return()=>{abort.abort();window.clearInterval(timer);window.removeEventListener('focus',tick);};
 },[enabled,onRefresh]);
 return result&&enabled?<OperationDialog compact title="Оплата подтверждена" onClose={()=>setResult(null)} footer={<button className={common.primaryButton} onClick={()=>setResult(null)}>Понятно</button>}>
  <p>{result.kind==='access'?'Доступ продлён до '+new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(result.accessEnd))+'.':'Добавлено '+result.units.toLocaleString('ru-RU')+' единиц Анализатора.'}</p>
 </OperationDialog>:null;
}
