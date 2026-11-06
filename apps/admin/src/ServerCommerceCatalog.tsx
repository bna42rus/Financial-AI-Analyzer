import {useEffect,useState} from 'react';
import {api} from '../../web/src/server-client';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {moneyFromRubles,rublesFromMinor,moneyLabel,durationLabel} from '../../../packages/access/src/model';
import type {Tariff} from '../../../packages/access/src/model';
import common from '../../web/src/App.module.css';
import styles from '../../web/src/ServerAccess.module.css';
type Pack={units:number;priceMinor:number;enabled:boolean};
type Catalog={plans:Tariff[];packs:Pack[]};
type Edit={id?:string;units?:number;price:string;months?:number;enabled:boolean};
export function ServerCommerceCatalog(){
 const [data,setData]=useState<Catalog|null>(null),[draft,setDraft]=useState<Edit|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{void api<Catalog>('/control/commerce-catalog').then(setData).catch(e=>setError(e.message));},[]);
 async function save(){if(!draft||busy)return;setError('');let priceMinor:string;try{priceMinor=moneyFromRubles(draft.price);if(BigInt(priceMinor)<100n||BigInt(priceMinor)>1000000n)throw Error();}catch{setError('Введите цену от 1 до 10 000 ₽.');return;}
  setBusy(true);try{setData(await api<Catalog>('/control/commerce-catalog',{...('id'in draft?{id:draft.id,months:draft.months}:{units:draft.units}),priceMinor,enabled:draft.enabled}));setDraft(null);}catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить тариф.');}finally{setBusy(false);}
 }
 return <><div className={styles.layout}><section className={styles.card}><h2>Доступ</h2><p>Новая цена действует для новых заявок. У сохранённых заявок цена останется прежней.</p>{data?.plans.map(t=><article className={styles.record} key={t.id}><strong>{durationLabel(t.duration)} · {moneyLabel(t.priceMinor)}</strong><p>{t.active?'Доступен в заявках':'Скрыт'}</p><button className={styles.secondary} onClick={()=>{setError('');setDraft({id:t.id,price:rublesFromMinor(t.priceMinor),months:t.duration.count,enabled:t.active});}}>Изменить</button></article>)}</section>
 <section className={styles.card}><h2>Пакеты Анализатора</h2>{data?.packs.map(p=><article className={styles.record} key={p.units}><strong>{p.units.toLocaleString('ru-RU')} единиц · {moneyLabel(String(p.priceMinor))}</strong><p>{p.enabled?'Доступен в тестовом магазине':'Скрыт'}</p><button className={styles.secondary} onClick={()=>{setError('');setDraft({units:p.units,price:rublesFromMinor(String(p.priceMinor)),enabled:p.enabled});}}>Изменить</button></article>)}</section></div>
 {!draft&&error&&<p className={styles.error} role="alert">{error}</p>}
 {draft&&<OperationDialog narrow title={draft.id?'Настроить тариф':'Настроить пакет'} onClose={()=>{if(!busy)setDraft(null);}} footer={<><button className={common.button} disabled={busy} onClick={()=>setDraft(null)}>Отменить</button><button form="admin-commerce-editor" className={common.primaryButton} disabled={busy} type="submit">Сохранить</button></>}>
  <form id="admin-commerce-editor" className={styles.renewalBody} onSubmit={e=>{e.preventDefault();void save();}}><OperationField label="Цена, ₽" error={error||undefined}><input inputMode="decimal" value={draft.price} onChange={e=>{setError('');setDraft({...draft,price:e.target.value});}}/></OperationField>
  {draft.id&&<OperationField label="Срок, месяцев"><input type="number" min={1} max={24} required value={draft.months} onChange={e=>setDraft({...draft,months:Number(e.target.value)})}/></OperationField>}
  <label><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>Показывать пользователям</label></form>
 </OperationDialog>}</>;
}
