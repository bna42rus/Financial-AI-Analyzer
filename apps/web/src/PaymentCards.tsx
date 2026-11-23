import {CreditCard} from 'lucide-react';
import {useState} from 'react';
import {useAccessBilling} from './AccessBilling';
import {TrialStart} from './TrialOnboarding';
import {cardLabel} from './CardPicker';
import type {PaymentCard} from './CardPicker';
import {OperationDialog} from './OperationDialog';
import {api} from './server-client';
import common from './App.module.css';
import styles from './ServerAccess.module.css';
export function PaymentCards(){
 const {state,loaded,error,reload}=useAccessBilling(),[adding,setAdding]=useState(false),[removing,setRemoving]=useState<PaymentCard|null>(null),[busy,setBusy]=useState(false),[failure,setFailure]=useState('');
 async function remove(){if(!removing||busy)return;setBusy(true);setFailure('');try{await api('/access/card-remove',{id:removing.id,disableRenewal:removing.forRenewal===true});await reload();window.dispatchEvent(new Event('cashneuro-billing'));setRemoving(null);}catch(e){setFailure(e instanceof Error?e.message:'Не удалось удалить карту.');}finally{setBusy(false);}}
 return <section className={styles.accountSection}><h2><CreditCard size={18}/>Банковские карты</h2>{!loaded&&<p role="status">Загружаем карты…</p>}{error&&<button className={styles.secondary} onClick={()=>void reload().catch(()=>{})}>Повторить загрузку карт</button>}{state&&<>{!state.cards?.length&&<p>Нет привязанных карт.</p>}<ul className={styles.savedCards}>{state.cards?.map(c=><li key={c.id}><div><strong>{cardLabel(c)}</strong>{c.forRenewal&&<small>Используется для автопродления</small>}</div><button className={styles.secondary} onClick={()=>{setFailure('');setRemoving(c);}}>Удалить</button></li>)}</ul><button className={styles.secondary} disabled={!(state.cardsEnabled??state.enabled)} onClick={()=>setAdding(true)}>Добавить карту</button></>}
 {adding&&<OperationDialog compact title="Привязка карты" footer={null} onClose={()=>setAdding(false)}><TrialStart binding onRefresh={async()=>{await reload();setAdding(false);window.dispatchEvent(new Event('cashneuro-billing'));}}/></OperationDialog>}
 {removing&&<OperationDialog compact title="Удалить карту" onClose={()=>{if(!busy)setRemoving(null);}} footer={<><button className={common.button} disabled={busy} onClick={()=>setRemoving(null)}>Отмена</button><button className={common.dangerButton} disabled={busy} onClick={()=>void remove()}>{removing.forRenewal?'Отключить автопродление и удалить':'Удалить карту'}</button></>}><div className={styles.renewalBody}><p>{cardLabel(removing)}</p><p>{removing.forRenewal?'Карта используется для автопродления. Можно выбрать другую в настройке автопродления или отключить его и удалить эту карту. Оплаченный доступ сохранится.':'Карта исчезнет из списка доступных способов оплаты. Оплаченный доступ сохранится.'}</p>{failure&&<p className={styles.error} role="alert">{failure}</p>}</div></OperationDialog>}</section>;
}
