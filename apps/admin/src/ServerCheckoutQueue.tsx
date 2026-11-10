import {SelectField} from '../../web/src/SelectField';
import {useEffect,useState} from 'react';
import {api,ApiError} from '../../web/src/server-client';
import {SearchField,foldSearch} from '../../web/src/SearchFilter';
import {moneyLabel} from '../../../packages/access/src/model';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {adminLink,useAdminData,useAdminTime,useAdminNotice} from './admin-view';
import styles from '../../web/src/ServerAccess.module.css';
import common from '../../web/src/App.module.css';
import shell from './ServerAdmin.module.css';

const labels={created:'Создан',pending:'Ожидает оплаты',paid:'Оплачен',cancelled:'Отменён',reconcile:'Требует сверки'};
const cancelReasons:Record<string,string>={expired_on_confirmation:'Истёк срок оплаты',insufficient_funds:'Недостаточно средств',canceled_by_merchant:'Платёж отменён магазином',general_decline:'Платёж отклонён',issuer_unavailable:'Банк недоступен',payment_method_restricted:'Ограничение способа оплаты',fraud_suspected:'Платёж отклонён платёжным сервисом'};
const reconcileReasons:Record<string,string>={provider_reference_missing:'CashNeuro не получил номер платежа ЮKassa.',first_access_not_issued:'Оплата подтверждена, но выдача приглашения не завершилась.',autorenewal_consent_changed:'Перед списанием изменились условия автопродления.'};
const providerStates:Record<string,string>={succeeded:'Оплачен',canceled:'Отменён',pending:'Ожидает оплаты',waiting_for_capture:'Ожидает подтверждения списания'};
type Refund={id:string;state:'pending'|'succeeded'|'canceled';amountMinor:number;at:string};
type Order={id:string;channel:'first'|'renewal';status:keyof typeof labels;mode:'once'|'enroll'|'automatic';tariff:string;price_minor:string;provider_id:string|null;created_at:string;paid_at:string|null;
 application_id:string|null;user_id:string|null;email:string|null;provider_paid_at:string|null;provider_expires_at:string|null;cancellation_reason:string|null;previous_end:string|null;access_end:string|null;reconcile_reason:string|null;
 reconciliation:{state:string;providerStatus:string|null;message:string|null;providerId:string|null}|null;refunds:Refund[];registered:boolean};

export function ServerCheckoutQueue({refresh,target,initialSearch}:{refresh:number;target?:string;initialSearch?:string}){
 const {data,error,loading,reload}=useAdminData<{orders:Order[]}>('/control/access-checkouts'+(target?'?id='+encodeURIComponent(target):''),refresh);
 const [filter,setFilter]=useState('all'),[search,setSearch]=useState(initialSearch??'');
 const visible=data?.orders.filter(o=>o.id===target||(filter==='all'||filter===o.status)&&foldSearch([o.email,o.tariff,o.id,o.provider_id].join(' ')).includes(foldSearch(search.trim())));
 useEffect(()=>{if(initialSearch!==undefined)setSearch(initialSearch);},[initialSearch]);
 const waiting=data?.orders.some(o=>['checking','applying'].includes(o.reconciliation?.state??''));
 useEffect(()=>{if(!waiting)return;const timer=setInterval(reload,3500);return()=>clearInterval(timer);},[waiting]);
 return <section className={styles.card}><div className={shell.filters}>
  <SearchField aria-label="Поиск платежей" placeholder="Почта, тариф или номер платежа" value={search} onValueChange={setSearch}/>
  <SelectField aria-label="Статус платежа" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Все статусы</option>{Object.entries(labels).filter(([key])=>key!=='created').map(([key,title])=><option key={key} value={key}>{title}</option>)}</SelectField>
 </div>
 {error&&<p className={styles.error} role="alert">{error}</p>}{loading&&!data&&<p role="status">Загружаем платежи…</p>}{visible?.length===0&&<p>{data?.orders.length?'Платежи не найдены.':'Платежей пока нет.'}</p>}
 <div className={shell.records+' '+shell.recordCards}>{visible?.map(order=><PaymentRow key={order.id} order={order} highlight={order.id===target} onChanged={reload}/>)}</div>
 </section>;
}
function PaymentRow({order,highlight,onChanged}:{order:Order;highlight:boolean;onChanged:()=>void}){
 const time=useAdminTime();
 const [form,setForm]=useState<''|'check'|'apply'>(''),[providerId,setProviderId]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirmation,setConfirmation]=useState<string|null>(null);
 const refunds=order.refunds??[],returned=refunds.filter(row=>row.state==='succeeded').reduce((total,row)=>total+row.amountMinor,0);
 const paymentKind=order.channel==='first'?'Первый доступ':order.mode==='automatic'?'Автопродление':'Продление';
 const reviewed=order.reconciliation?.state==='verified'&&['succeeded','canceled'].includes(order.reconciliation.providerStatus??'');
 const processing=['checking','applying'].includes(order.reconciliation?.state??'');
 const notify=useAdminNotice(),needsNumber=form==='check'&&!order.provider_id;
 function validRef(){if(needsNumber&&!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(providerId.trim())){setError('Введите номер платежа из кабинета ЮKassa.');return false;}return true;}
 async function submit(){
  if(!form||busy)return;
  const ref=providerId.trim();
  if(!validRef())return;
  setBusy(true);setError('');
  try{await api('/control/checkout-reconciliation',{actionId:confirmation??crypto.randomUUID(),checkoutId:order.id,step:form,...(form==='check'&&!order.provider_id?{providerId:ref}:{})});notify(form==='check'?'Сверка поставлена в очередь.':'Применение результата поставлено в очередь.');setForm('');onChanged();}
  catch(e){setError(e instanceof Error?e.message:'Не удалось отправить запрос на сверку.');if(e instanceof ApiError&&e.code==='PAYMENT_RECONCILIATION_UNAVAILABLE')onChanged();}
  finally{setBusy(false);}
 }
 return <article data-highlight={highlight}>
  <div className={shell.paymentHead}><strong>{moneyLabel(order.price_minor)} · {order.tariff}</strong><span className={order.status==='reconcile'?shell.attention:order.status==='paid'?shell.success:shell.badge}>{labels[order.status]}</span></div>
  <p>{order.email??'Адрес недоступен'} · {paymentKind} · {time.format(order.provider_paid_at??order.paid_at??order.created_at)}</p>
  {order.status==='cancelled'&&order.cancellation_reason&&<p>{cancelReasons[order.cancellation_reason]??'ЮKassa сообщила об отмене платежа.'}</p>}
  {order.status==='pending'&&order.provider_expires_at&&<p>Оплатить до {time.format(order.provider_expires_at)}</p>}
  {returned>0&&<p>{returned>=Number(order.price_minor)?'Возвращён полностью':'Частичный возврат'} · {moneyLabel(String(returned))}</p>}
  <details key={String(highlight)} open={highlight||undefined}><summary>Подробнее</summary><div>
   <dl className={shell.detailList}><div><dt>Заказ CashNeuro</dt><dd>{order.id}</dd></div>{order.provider_id&&<div><dt>Номер в ЮKassa</dt><dd>{order.provider_id}</dd></div>}
    <div><dt>Заказ создан</dt><dd>{time.format(order.created_at)}</dd></div>
    {order.provider_paid_at&&<div><dt>Оплата по данным ЮKassa</dt><dd>{time.format(order.provider_paid_at)}</dd></div>}
    {order.paid_at&&<div><dt>Подтверждено CashNeuro</dt><dd>{time.format(order.paid_at)}</dd></div>}
    {order.access_end&&<div><dt>Срок доступа</dt><dd>{order.previous_end&&time.format(order.previous_end)+' → '}{time.format(order.access_end)}</dd></div>}
   </dl>
   {order.status==='reconcile'&&<>
    <p>{reconcileReasons[order.reconcile_reason??'']??'Проверьте операцию в ЮKassa.'}</p>
    {order.reconciliation?.providerStatus&&<p>ЮKassa · {providerStates[order.reconciliation.providerStatus]}</p>}
    {order.reconciliation?.message&&<p className={order.reconciliation.state==='unknown'?styles.error:undefined}>{order.reconciliation.message}</p>}
    {processing?<p role="status">Проверяем платёж…</p>:<div className={shell.detailActions}>
     <button className={styles.secondary} onClick={()=>{setError('');setProviderId(order.reconciliation?.providerId??'');setConfirmation(null);setForm('check');}}>Сверить платёж</button>
     {reviewed&&<button className={styles.primary} onClick={()=>{setError('');setConfirmation(crypto.randomUUID());setForm('apply');}}>Применить результат</button>}
    </div>}
   </>}
   {refunds.length>0&&<section><h3>Возвраты</h3><ul>{refunds.map(r=><li key={r.id}>{moneyLabel(String(r.amountMinor))} · {time.format(r.at)} · {r.state==='succeeded'?'Подтверждён':r.state==='pending'?'Обрабатывается':'Отменён'}</li>)}</ul></section>}
   {(order.application_id||order.user_id||order.provider_id&&order.status==='paid'&&returned<Number(order.price_minor))&&<div className={shell.detailActions}>
    {order.application_id&&<a className={styles.secondary} href={adminLink('requests',{id:order.application_id})}>Открыть заявку</a>}
    {order.user_id&&<a className={styles.secondary} href={adminLink('users',{id:order.user_id})}>{returned>0?'Проверить доступ':'Открыть пользователя'}</a>}
    {order.provider_id&&order.status==='paid'&&returned<Number(order.price_minor)&&<a className={styles.secondary} href="https://yookassa.ru/my/" target="_blank" rel="noreferrer">Открыть кабинет ЮKassa</a>}
   </div>}
  </div></details>
  {form&&<OperationDialog narrow title={confirmation?'Подтверждение сверки':form==='check'?'Сверить платёж':'Применить результат сверки'} onClose={()=>{if(!busy)setForm('');}} footer={<>
   <button className={common.button} disabled={busy} onClick={()=>{if(needsNumber&&confirmation){setConfirmation(null);setError('');}else setForm('');}}>{needsNumber&&confirmation?'Назад':'Отмена'}</button><button className={common.primaryButton} disabled={busy} onClick={()=>{if(needsNumber&&!confirmation){if(validRef())setConfirmation(crypto.randomUUID());}else void submit();}}>{needsNumber&&!confirmation?'Продолжить':'Подтвердить'}</button>
  </>}>
   <div className={styles.renewalBody}>
    <p>{form==='check'?'CashNeuro проверит статус, сумму и связь платежа с заказом.':order.reconciliation?.providerStatus==='succeeded'?'Если ЮKassa подтверждает оплату, CashNeuro завершит обработку заказа.':'Если ЮKassa подтверждает отмену, CashNeuro закроет попытку оплаты.'}</p>
    {confirmation&&<p>Номер платежа: {order.provider_id??providerId}</p>}
    {needsNumber&&!confirmation?<OperationField label="Номер платежа в ЮKassa" error={error||undefined}><input value={providerId} maxLength={36} onChange={e=>{setProviderId(e.target.value);setError('');}}/></OperationField>:error&&<p className={styles.error} role="alert">{error}</p>}
   </div>
  </OperationDialog>}
 </article>;
}
