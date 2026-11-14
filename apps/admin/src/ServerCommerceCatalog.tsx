import {Plus} from 'lucide-react';
import {SelectField} from '../../web/src/SelectField';
import {useEffect,useState} from 'react';
import {api,ApiError} from '../../web/src/server-client';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {catalogDurationLabel,moneyLabel} from '../../../packages/access/src/model';
import type {Tariff} from '../../../packages/access/src/model';
import common from '../../web/src/App.module.css';
import styles from '../../web/src/ServerAccess.module.css';
import {useAdminNotice} from './admin-view';
import shell from './ServerAdmin.module.css';

type Pack={id:string;units:number;priceMinor:number;enabled:boolean};
type Catalog={plans:Tariff[];packs:Pack[]};
type Draft={kind:'plan'|'pack';original?:Tariff|Pack;price:string;count:string;durationKind:Tariff['duration']['kind'];quota:string;units:string;enabled:boolean};
type Field='price'|'count'|'quota'|'units'|'form';
const empty=(kind:Draft['kind']):Draft=>({kind,price:'',count:'',durationKind:'days',quota:'',units:'',enabled:true});
const fieldByCode:Record<string,Field>={INVALID_TARIFF_PRICE:'price',INVALID_TARIFF_DURATION:'count',INVALID_TARIFF_LIMIT:'quota',INVALID_PACK_UNITS:'units',PACK_UNITS_EXIST:'units'};
const number=(value:string,min:number,max:number)=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>=min&&Number(value)<=max;
const displayPrice=(minor:string|number)=>Number(minor)%100===0?String(Number(minor)/100):'';

export function ServerCommerceCatalog({refresh=0}:{refresh?:number}){
 const [data,setData]=useState<Catalog|null>(null),[draft,setDraft]=useState<Draft|null>(null),[error,setError]=useState(''),[errors,setErrors]=useState<Partial<Record<Field,string>>>({}),[busy,setBusy]=useState(false),[review,setReview]=useState(false),[archive,setArchive]=useState<Tariff|Pack|null>(null);
 const notify=useAdminNotice();
 useEffect(()=>{const abort=new AbortController();setError('');void api<Catalog>('/control/commerce-catalog',undefined,abort.signal).then(setData).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[refresh]);
 function edit(next:Draft){setErrors({});setReview(false);setDraft(next);}
 function update(field:Field,value:string){if(!draft||field==='form'||!/^\d*$/.test(value))return;setErrors(previous=>({...previous,[field]:undefined,form:undefined}));setDraft({...draft,[field]:value.replace(/^0+(?=\d)/,'')});}
 function validate(){
  if(!draft||busy)return;
  const nextErrors:typeof errors={};
  if(!number(draft.price,1,10000))nextErrors.price='Введите целое число от 1 до 10 000 ₽.';
  if(draft.kind==='plan'){
   if(!number(draft.count,1,draft.durationKind==='days'?36500:120))nextErrors.count=draft.durationKind==='days'?'Введите от 1 до 36 500 дней.':'Введите от 1 до 120 месяцев.';
   if(!number(draft.quota,0,1000000))nextErrors.quota='Введите целое число от 0 до 1 000 000.';
  }else if(!number(draft.units,1,1000000))nextErrors.units='Введите целое число от 1 до 1 000 000.';
  setErrors(nextErrors);if(!Object.keys(nextErrors).length)setReview(true);
 }
 async function save(){
  if(!draft||busy)return;
  const old=draft.original;
  const target=draft.kind==='plan'?{...(old&&'duration'in old?{id:old.id,expectedVersion:old.catalogVersion??0}:{}),count:Number(draft.count),durationKind:draft.durationKind,aiQuota:Number(draft.quota)}:
   {...(old&&'units'in old?{packId:old.id,expectedUnits:old.units,expectedPriceMinor:old.priceMinor,expectedEnabled:old.enabled}:{}),units:Number(draft.units)};
  setBusy(true);try{setData(await api<Catalog>('/control/commerce-catalog',{kind:draft.kind,...target,priceMinor:String(Number(draft.price)*100),enabled:draft.enabled}));setDraft(null);notify('Изменения каталога сохранены.');}
  catch(e){const field=e instanceof ApiError?fieldByCode[e.code]??'form':'form';if(field!=='form')setReview(false);setErrors({[field]:e instanceof Error?e.message:'Не удалось сохранить изменения.'});}
  finally{setBusy(false);}
 }
 async function remove(){
  if(!archive||busy)return;
  setBusy(true);setErrors({});
  const body='duration'in archive?{kind:'plan',id:archive.id,expectedVersion:archive.catalogVersion??0}:{kind:'pack',id:archive.id,expectedUnits:archive.units,expectedPriceMinor:archive.priceMinor,expectedEnabled:archive.enabled};
  try{setData(await api<Catalog>('/control/commerce-catalog-archive',body));notify('Позиция удалена из каталога.');setArchive(null);}
  catch(e){setErrors({form:e instanceof Error?e.message:'Не удалось удалить позицию.'});}
  finally{setBusy(false);}
 }
 const beginArchive=(entry:Tariff|Pack)=>{setErrors({});setArchive(entry);};
 return <>
 {error&&<p className={styles.error} role="alert">{error}</p>}
 {!data&&!error&&<p role="status">Загружаем тарифы…</p>}
 <div className={styles.layout}>
  <section className={styles.card}><div className={shell.listHead}><h2>Доступ</h2><button className={styles.primary} onClick={()=>edit(empty('plan'))}><Plus size={16}/>Добавить тариф</button></div>
  <p>Каталог применяется к новым заказам. Для автопродления на новых условиях потребуется подтверждение.</p>
  {data?.plans.map(t=><article className={shell.catalogRow} key={t.id}><div><div className={shell.listHead}><strong>{catalogDurationLabel(t.duration)} · {moneyLabel(t.priceMinor)}</strong><span className={shell.badge}>{t.active?'Опубликован':'Скрыт'}</span></div><small>{t.aiQuota.toLocaleString('ru-RU')} единиц {t.duration.kind==='days'?'за период':'в месяц'}</small></div>
   <div className={shell.rowActions}><button className={styles.secondary} onClick={()=>edit({...empty('plan'),original:t,price:displayPrice(t.priceMinor),count:String(t.duration.count),durationKind:t.duration.kind,quota:String(t.aiQuota),enabled:t.active})}>Изменить</button><button className={styles.secondary+' '+shell.destructive} onClick={()=>beginArchive(t)}>Удалить</button></div></article>)}</section>
  <section className={styles.card}><div className={shell.listHead}><h2>Пакеты Анализатора</h2><button className={styles.primary} onClick={()=>edit(empty('pack'))}><Plus size={16}/>Добавить пакет</button></div>
  {data?.packs.map(p=><article className={shell.catalogRow} key={p.id}><div><strong>{p.units.toLocaleString('ru-RU')} единиц · {moneyLabel(String(p.priceMinor))}</strong><p><span className={shell.badge}>{p.enabled?'Доступен':'Скрыт'}</span></p></div>
   <div className={shell.rowActions}><button className={styles.secondary} onClick={()=>edit({...empty('pack'),original:p,price:displayPrice(p.priceMinor),units:String(p.units),enabled:p.enabled})}>Изменить</button><button className={styles.secondary+' '+shell.destructive} onClick={()=>beginArchive(p)}>Удалить</button></div></article>)}</section>
 </div>
 {draft&&<OperationDialog narrow title={review?'Подтверждение изменений':draft.kind==='plan'?(draft.original?'Настроить тариф':'Добавить тариф'):(draft.original?'Настроить пакет':'Добавить пакет')} onClose={()=>{if(!busy)setDraft(null);}} footer={<>
  <button className={common.button} disabled={busy} onClick={()=>{if(review){setReview(false);setErrors({});}else setDraft(null);}}>{review?'Назад':'Отмена'}</button>{review?<button className={common.primaryButton} disabled={busy} onClick={()=>void save()}>Подтвердить</button>:<button form="admin-commerce-editor" className={common.primaryButton} type="submit">Продолжить</button>}</>}>
  {review?<div className={styles.renewalBody}>
   {draft.kind==='plan'?<p>Срок: {draft.original&&'duration'in draft.original?catalogDurationLabel(draft.original.duration)+' → ':''}{catalogDurationLabel({kind:draft.durationKind,count:Number(draft.count)})}. Лимит: {draft.original&&'duration'in draft.original?draft.original.aiQuota+' → ':''}{draft.quota} ед.</p>:<p>Количество: {draft.original&&'units'in draft.original?draft.original.units+' → ':''}{draft.units} ед.</p>}
   <p>Цена: {draft.original?moneyLabel(String(draft.original.priceMinor))+' → ':''}{draft.price} ₽.</p>
   <p>В каталоге: {draft.enabled?'Показывать':'Скрыть'}.</p>
   {errors.form&&<p className={styles.error} role="alert">{errors.form}</p>}
  </div>:<form id="admin-commerce-editor" className={styles.renewalBody} onSubmit={e=>{e.preventDefault();validate();}}>
   <OperationField label="Цена, ₽" error={errors.price}><input inputMode="numeric" value={draft.price} onChange={e=>update('price',e.target.value)}/></OperationField>
   {draft.kind==='plan'?<>
    <OperationField label="Единица срока"><SelectField value={draft.durationKind} onChange={e=>setDraft({...draft,durationKind:e.target.value as Tariff['duration']['kind']})}><option value="days">Дни</option><option value="calendar_months">Месяцы</option></SelectField></OperationField>
    <OperationField label="Срок" error={errors.count}><input inputMode="numeric" value={draft.count} onChange={e=>update('count',e.target.value)}/></OperationField>
    <OperationField label={draft.durationKind==='days'?'Лимит за период':'Лимит в месяц'} error={errors.quota}><input inputMode="numeric" value={draft.quota} onChange={e=>update('quota',e.target.value)}/></OperationField>
   </>:<OperationField label="Количество единиц" error={errors.units}><input inputMode="numeric" value={draft.units} onChange={e=>update('units',e.target.value)}/></OperationField>}
   <label className={shell.check}><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>Показывать пользователям</label>
   {errors.form&&<p className={styles.error} role="alert">{errors.form}</p>}
  </form>}
 </OperationDialog>}
 {archive&&<OperationDialog narrow title={'duration'in archive?'Удалить тариф?':'Удалить пакет?'} onClose={()=>{if(!busy)setArchive(null);}} footer={<>
  <button className={common.button} disabled={busy} onClick={()=>setArchive(null)}>Отмена</button><button className={common.dangerButton} disabled={busy} onClick={()=>void remove()}>Удалить</button>
 </>}><div className={styles.renewalBody}><p><strong>{'duration'in archive?catalogDurationLabel(archive.duration):archive.units.toLocaleString('ru-RU')+' ед.'} · {moneyLabel(String(archive.priceMinor))}</strong></p><p>Предложение исчезнет из каталога. Оплаченные заказы и начисленные единицы сохранятся.</p>{errors.form&&<p className={styles.error} role="alert">{errors.form}</p>}</div></OperationDialog>}
 </>;
}
