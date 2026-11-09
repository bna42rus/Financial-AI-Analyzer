import {SearchField,foldSearch} from '../../web/src/SearchFilter';
import {SelectField} from '../../web/src/SelectField';
import {useEffect,useState} from 'react';
import {api} from '../../web/src/server-client';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {moneyFromRubles,rublesFromMinor,moneyLabel} from '../../../packages/access/src/model';
import type {Tariff} from '../../../packages/access/src/model';
import common from '../../web/src/App.module.css';
import styles from '../../web/src/ServerAccess.module.css';
type Pack={units:number;priceMinor:number;enabled:boolean};
type Catalog={plans:Tariff[];packs:Pack[]};
type Edit={id?:string;units?:number;price:string;count?:number;durationKind?:Tariff['duration']['kind'];aiQuota?:number;expectedVersion?:number;enabled:boolean};
export function ServerCommerceCatalog(){
 const [data,setData]=useState<Catalog|null>(null),[draft,setDraft]=useState<Edit|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState('');
 useEffect(()=>{void api<Catalog>('/control/commerce-catalog').then(setData).catch(e=>setError(e.message));},[]);
 async function save(){if(!draft||busy)return;setError('');let priceMinor:string;try{priceMinor=moneyFromRubles(draft.price);if(BigInt(priceMinor)<100n||BigInt(priceMinor)>1000000n)throw Error();}catch{setError('Введите цену от 1 до 10 000 ₽.');return;}
  setBusy(true);try{setData(await api<Catalog>('/control/commerce-catalog',{...('id'in draft?{id:draft.id,count:draft.count,durationKind:draft.durationKind,aiQuota:draft.aiQuota,expectedVersion:draft.expectedVersion}:{units:draft.units}),priceMinor,enabled:draft.enabled}));setDraft(null);}catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить тариф.');}finally{setBusy(false);}
 }
 const matches=(value:string)=>foldSearch(value).includes(foldSearch(query.trim()));
 const plans=data?.plans.filter(t=>matches([t.name,moneyLabel(t.priceMinor),t.aiQuota,t.id].join(' ')));
 const packs=data?.packs.filter(p=>matches([p.units,p.units.toLocaleString('ru-RU'),moneyLabel(String(p.priceMinor))].join(' ')));
 return <><SearchField value={query} onValueChange={setQuery} placeholder="Название тарифа, цена или единицы" aria-label="Поиск тарифов и пакетов"/>{data&&(!plans?.length&&!packs?.length)&&<p>Тарифы и пакеты не найдены.</p>}<div className={styles.layout}><section className={styles.card}><h2>Доступ</h2><p>Изменения сразу видны в каталоге. Оплаченные периоды и сохранённые заказы не изменятся. Для автопродления на новых условиях потребуется подтверждение.</p>{plans?.map(t=><article className={styles.record} key={t.id}><strong>{t.name} · {moneyLabel(t.priceMinor)}</strong><p>{t.active?'Опубликован':'Скрыт'} · {t.aiQuota.toLocaleString('ru-RU')} единиц {t.duration.kind==='days'?'за период':'в месяц'}</p><button className={styles.secondary} onClick={()=>{setError('');setDraft({id:t.id,price:rublesFromMinor(t.priceMinor),count:t.duration.count,durationKind:t.duration.kind,aiQuota:t.aiQuota,expectedVersion:t.catalogVersion??0,enabled:t.active});}}>Изменить</button></article>)}</section>
 <section className={styles.card}><h2>Пакеты Анализатора</h2>{packs?.map(p=><article className={styles.record} key={p.units}><strong>{p.units.toLocaleString('ru-RU')} единиц · {moneyLabel(String(p.priceMinor))}</strong><p>{p.enabled?'Доступен пользователям':'Скрыт'}</p><button className={styles.secondary} onClick={()=>{setError('');setDraft({units:p.units,price:rublesFromMinor(String(p.priceMinor)),enabled:p.enabled});}}>Изменить</button></article>)}</section></div>
 {!draft&&error&&<p className={styles.error} role="alert">{error}</p>}
 {draft&&<OperationDialog narrow title={draft.id?'Настроить тариф':'Настроить пакет'} onClose={()=>{if(!busy)setDraft(null);}} footer={<><button className={common.button} disabled={busy} onClick={()=>setDraft(null)}>Отменить</button><button form="admin-commerce-editor" className={common.primaryButton} disabled={busy} type="submit">Сохранить</button></>}>
  <form id="admin-commerce-editor" className={styles.renewalBody} onSubmit={e=>{e.preventDefault();void save();}}><OperationField label="Цена, ₽" error={error||undefined}><input inputMode="decimal" value={draft.price} onChange={e=>{setError('');setDraft({...draft,price:e.target.value});}}/></OperationField>
  {draft.id&&<><OperationField label="Единица срока"><SelectField value={draft.durationKind} onChange={e=>setDraft({...draft,durationKind:e.target.value as Tariff['duration']['kind']})}><option value="days">Дни</option><option value="calendar_months">Месяцы</option></SelectField></OperationField><OperationField label="Срок"><input type="number" min={1} max={draft.durationKind==='days'?31:24} required value={draft.count} onChange={e=>setDraft({...draft,count:Number(e.target.value)})}/></OperationField><OperationField label={draft.durationKind==='days'?'Лимит за период':'Лимит в месяц'}><input type="number" min={0} max={1000000} required value={draft.aiQuota} onChange={e=>setDraft({...draft,aiQuota:Number(e.target.value)})}/></OperationField></>}
  <label><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>Показывать пользователям</label></form>
 </OperationDialog>}</>;
}
