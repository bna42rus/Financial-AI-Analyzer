import {useEffect,useState} from 'react';
import {CalendarDays,Sparkles} from 'lucide-react';
import {SearchField} from '../../web/src/SearchFilter';
import {SelectField} from '../../web/src/SelectField';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {api,ApiError} from '../../web/src/server-client';
import {catalogDurationLabel,moneyLabel} from '../../../packages/access/src/model';
import {termLabel} from '../../../packages/access/src/manual';
import type {ManualCommand,ManualPreview,ManualQueue,ManualUser,ManualTerm,QuotaPolicy} from '../../../packages/access/src/manual';
import {adminLink,localAdminDate,parseAdminDate,useAdminData,useAdminTime,useAdminNotice} from './admin-view';
import common from '../../web/src/App.module.css';
import styles from '../../web/src/ServerAccess.module.css';
import shell from './ServerAdmin.module.css';

const count=(n:number)=>n.toLocaleString('ru-RU');
const status=(u:ManualUser)=>u.cycle?.indefinite?'Бессрочный':u.cycle?.accessEnd&&Date.parse(u.cycle.accessEnd)>Date.now()?'Действует':u.cycle?.accessEnd?'Истёк':'Доступ не выдан';
function quotaLabel(q:QuotaPolicy){
 if(q.source==='override'&&q.budgetMinor!==undefined)return moneyLabel(q.budgetMinor)+' в месяц на модель';
 return count(q.limit)+' единиц '+(q.source==='tariff'&&q.periodDays?'каждые '+q.periodDays+' дней':'в месяц');
}
function spend(atoms:string){
 const n=BigInt(atoms),f=(n%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');
 return (n/1000000000n).toLocaleString('ru-RU')+(f?','+f:'')+' ₽';
}
type Panel='invite'|'access'|'quota'|'status';
export function ServerManualAccess({refresh,target}:{refresh:number;target?:string}){
 const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[filter,setFilter]=useState(''),[page,setPage]=useState(0),[selected,setSelected]=useState(target??''),[panel,setPanel]=useState<Panel|null>(null);
 const params=new URLSearchParams({search,filter,page:String(page),target:target??''});
 const {data,error,loading,reload}=useAdminData<ManualQueue>('/control/accesses?'+params,refresh);
 const time=useAdminTime(),notify=useAdminNotice();
 useEffect(()=>{const timer=setTimeout(()=>{setSearch(query.trim());setPage(0);},250);return()=>clearTimeout(timer);},[query]);
 useEffect(()=>{if(target){setSelected(target);setQuery('');setFilter('');setPage(0);}},[target]);
 const user=data?.users.find(u=>u.userId===selected);
 const formatTerm=(u:ManualUser)=>u.cycle?.indefinite?'Бессрочно':u.cycle?.accessEnd?'До '+time.format(u.cycle.accessEnd):'Срок не задан';
 function done(message:string){setPanel(null);notify(message);reload();}
 return <>
  <div className={styles.layout}>
   <section className={styles.card} aria-label="Пользователи"><div className={shell.filters+' '+shell.userToolbar}>
    <SearchField value={query} onValueChange={setQuery} placeholder="Имя или почта" aria-label="Поиск пользователей"/>
    <SelectField value={filter} aria-label="Статус доступа" onChange={e=>{setFilter(e.target.value);setPage(0);}}><option value="">Все статусы</option><option value="active">Действует</option><option value="expired">Истёк</option><option value="unlimited">Бессрочный</option><option value="blocked">Заблокирован</option></SelectField>
    <button className={styles.primary} disabled={!data} onClick={()=>setPanel('invite')}>Выдать доступ по email</button>
   </div>
   {error&&<p className={styles.error} role="alert">{error}</p>}{loading&&!data&&<p role="status">Загружаем пользователей…</p>}
   {data?.users.length===0&&!loading&&<p>Пользователи не найдены.</p>}
   <div className={styles.list+' '+shell.userList}>{data?.users.map(row=><button key={row.userId} className={styles.secondary} aria-pressed={selected===row.userId} data-highlight={target===row.userId} onClick={()=>setSelected(row.userId)}>
    <div className={shell.paymentHead}><strong>{row.name||row.email}</strong><span className={row.status==='suspended'?shell.attention:shell.badge}>{row.status==='suspended'?'Заблокирован':status(row)}</span></div>
    <p>{row.email}</p><small>{formatTerm(row)}</small>
   </button>)}</div>
   {(page>0||data?.hasMore)&&<div className={styles.actions}><button className={styles.secondary} disabled={page===0||loading} onClick={()=>setPage(n=>n-1)}>Назад</button><button className={styles.secondary} disabled={!data?.hasMore||loading} onClick={()=>setPage(n=>n+1)}>Дальше</button></div>}
   </section>
   {user?<section className={styles.card}>
    <div className={shell.paymentHead+' '+shell.userHeading}><h2>{user.name||user.email}</h2><span className={shell.badge}>{status(user)}</span></div><p>{user.email}</p>
    {user.status==='suspended'&&<span className={shell.attention}>Заблокирован</span>}
    <div className={shell.records}>
     <article><h3><CalendarDays size={17}/> Доступ</h3><dl className={shell.detailList}><div><dt>Срок</dt><dd>{formatTerm(user)}</dd></div><div><dt>Зарегистрирован</dt><dd>{time.format(user.registeredAt)}</dd></div></dl>
      <div className={shell.detailActions}><button className={styles.secondary} onClick={()=>setPanel('access')}>Изменить доступ</button><button className={styles.secondary} onClick={()=>setPanel('status')}>{user.status==='suspended'?'Снять блокировку':'Приостановить доступ'}</button></div></article>
     <article><h3><Sparkles size={17}/> Лимит Анализатора</h3><dl className={shell.detailList}>
      <div><dt>Включено</dt><dd>{user.analyzer?count(user.analyzer.units)+' единиц':'—'}</dd></div>
      <div><dt>Осталось включённых</dt><dd>{user.analyzer?.remaining===undefined?'—':count(user.analyzer.remaining)+' ед.'}</dd></div>
      <div><dt>Осталось докупленных</dt><dd>{user.analyzer?.purchased===undefined?'—':count(user.analyzer.purchased)+' ед.'}</dd></div>
      <div><dt><strong>Всего доступно</strong></dt><dd><strong>{user.analyzer?.remaining===undefined?'—':count(user.analyzer.resetAt&&user.status!=='suspended'?user.analyzer.remaining+(user.analyzer.purchased??0):0)+' ед.'}</strong></dd></div>
      {user.cycle?.quotaPolicy?.source==='tariff'&&user.cycle.quotaPolicy.periodDays&&<div><dt>Политика лимита</dt><dd>{quotaLabel(user.cycle.quotaPolicy)}</dd></div>}
      <div><dt>{user.analyzer?.manual?'Ручной лимит до':'Текущий период до'}</dt><dd>{time.format(user.analyzer?.resetAt)}</dd></div>
      <div><dt>Расход на модель за месяц</dt><dd>{user.analyzer?spend(user.analyzer.spentAtoms):'—'}</dd></div>
      {user.analyzer?.budgetMinor!=null&&<div><dt>Бюджет на модель</dt><dd>{moneyLabel(user.analyzer.budgetMinor)} в месяц</dd></div>}
     </dl><div className={shell.detailActions}><button className={styles.secondary} disabled={!user.cycle} onClick={()=>setPanel('quota')}>Изменить лимит</button></div></article>
    </div>
    <div className={shell.userLinks}><a href={adminLink('requests',{search:user.email})}>Заявки</a><a href={adminLink('payments',{search:user.email})}>Платежи</a><a href={adminLink('history',{search:user.email})}>История изменений</a></div>
   </section>:<aside className={styles.card}><p>Выберите пользователя, чтобы посмотреть его доступ и лимит Анализатора.</p></aside>}
  </div>
  {panel==='status'&&user&&<StatusEditor user={user} onClose={()=>setPanel(null)} onDone={done}/>}
  {data&&(panel==='invite'||user&&(panel==='access'||panel==='quota'))&&<AccessEditor panel={panel} user={user} data={data} onClose={()=>setPanel(null)} onDone={done}/>}
 </>;
}
function StatusEditor({user,onClose,onDone}:{user:ManualUser;onClose:()=>void;onDone:(message:string)=>void}){
 const [note,setNote]=useState(''),[endSessions,setEndSessions]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[missing,setMissing]=useState(false),[review,setReview]=useState<string|null>(null);
 const blocking=user.status!=='suspended';
 async function save(){
  if(!review||busy)return;
  setError('');setMissing(false);
  setBusy(true);
  try{await api('/control/user-status',{actionId:review,userId:user.userId,status:blocking?'suspended':'active',note,endSessions:blocking&&endSessions});onDone(blocking?'Доступ приостановлен. Уведомление поставлено в очередь.':'Блокировка снята. Уведомление поставлено в очередь.');}
  catch(e){setError(e instanceof Error?e.message:'Не удалось изменить статус.');}finally{setBusy(false);}
 }
 return <OperationDialog narrow title={review?'Подтверждение изменений':blocking?'Приостановить доступ':'Снять блокировку'} onClose={()=>{if(!busy)onClose();}} footer={<>
  <button className={common.button} disabled={busy} onClick={()=>{if(review){setReview(null);setError('');}else onClose();}}>{review?'Назад':'Отмена'}</button>
  {review?<button className={blocking?common.dangerButton:common.primaryButton} disabled={busy} onClick={()=>void save()}>Подтвердить</button>:<button className={common.primaryButton} onClick={()=>{if(!note.trim()){setMissing(true);setError('Добавьте заметку.');return;}setMissing(false);setError('');setReview(crypto.randomUUID());}}>Продолжить</button>}
 </>}><div className={styles.renewalBody}><p><strong>{user.email}</strong></p>
 <p>{blocking?'Операции, отчёты и Анализатор станут недоступны. Пользователь получит письмо с контактом поддержки.':'Пользователь получит письмо. Если оплаченный срок ещё действует, финансовые разделы откроются.'}</p>
 {review?<><p>Заметка: {note}</p>{blocking&&<p>Завершить сеансы: {endSessions?'Да':'Нет'}</p>}</>:<>
 <OperationField label="Заметка" error={missing?error:undefined}><textarea rows={2} maxLength={1000} value={note} onChange={e=>{setNote(e.target.value);setError('');}}/></OperationField>
 {blocking&&<label className={shell.check}><input type="checkbox" checked={endSessions} onChange={e=>setEndSessions(e.target.checked)}/>Завершить активные сеансы</label>}</>}
 {!missing&&error&&<p className={styles.error} role="alert">{error}</p>}
 </div></OperationDialog>;
}
function AccessEditor({panel,user,data,onClose,onDone}:{panel:Exclude<Panel,'status'>;user?:ManualUser;data:ManualQueue;onClose:()=>void;onDone:(message:string)=>void}){
 const [mode,setMode]=useState<ManualCommand['mode']>(panel==='invite'?'invite':panel==='quota'?'quota':user?.cycle?.indefinite?'set_end':'extend');
 const [kind,setKind]=useState<ManualTerm['kind']>('days'),[policy,setPolicy]=useState<'tariff'|'units'|'rubles'>(user?.cycle?.quotaPolicy?.source==='override'||!data.tariffs.length?'units':'tariff');
 const [preview,setPreview]=useState<{command:ManualCommand;result:ManualPreview}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[field,setField]=useState('');
 const time=useAdminTime(),inviting=panel==='invite',quota=panel==='quota';
 const needsQuota=inviting||quota||!user?.cycle;
 const duration=mode==='extend'||inviting,showCount=duration&&(kind==='days'||kind==='calendar_months'),fixed=mode==='set_end'||inviting&&kind==='fixed';
 const fieldError=(name:string)=>field===name?error:undefined;
 const mark=(name:string,message:string)=>{setField(name);setError(message);};
 const digits=(e:React.ChangeEvent<HTMLInputElement>)=>{e.target.value=e.target.value.replace(/\D/g,'').replace(/^0+(?=\d)/,'');setError('');};
 async function check(values:FormData){
  setError('');setField('');
  const note=String(values.get('note')??'').trim(),address=String(values.get('email')??'').trim();
  if(inviting&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)){mark('email','Введите адрес электронной почты.');return;}
  if(!note){mark('note','Добавьте заметку.');return;}
  const amount=Number(values.get('count')),hours=Number(values.get('hours'));
  if(showCount&&(!Number.isInteger(amount)||amount<1||amount>(kind==='days'?36500:1200))){mark('count','Проверьте количество дней или месяцев.');return;}
  if(inviting&&(!Number.isInteger(hours)||hours<1||hours>720)){mark('hours','Введите от 1 до 720 часов.');return;}
  let term:ManualTerm|undefined;
  if(fixed){
   try{const end=parseAdminDate(String(values.get('end')??''),time.zone);if(Date.parse(end)<=Date.now())throw Error('Выберите будущую дату окончания.');term={kind:'fixed',end};}
   catch(e){mark('end',e instanceof Error?e.message:'Проверьте дату.');return;}
  }else if(mode==='indefinite'||inviting&&kind==='indefinite')term={kind:'indefinite'};
  else if(showCount)term={kind:kind as 'days'|'calendar_months',count:amount};
  let nextQuota:ManualCommand['quota'];
  if(needsQuota){
   if(policy==='tariff'){
    const tariffId=String(values.get('tariff')??'');if(!tariffId){mark('tariff','Выберите тариф.');return;}
    nextQuota={source:'tariff',tariffId};
   }else{
    const amount=String(values.get('budget')??''),rubles=policy==='rubles';
    if(!/^\d+$/.test(amount)||Number(amount)>(rubles?10000:1000000)){mark('budget',rubles?'Введите целое число от 0 до 10 000 ₽.':'Введите целое число от 0 до 1 000 000.');return;}
    nextQuota={source:'override',limit:Number(amount)*(rubles?100:1)};
   }
  }
  const command:ManualCommand={actionId:crypto.randomUUID(),mode,reason:note,...(inviting?{email:address,accessType:'Free',inviteHours:hours}:{userId:user!.userId}),...(term?{term}:{}),...(nextQuota?{quota:nextQuota}:{})};
  setBusy(true);
  try{const result=await api<ManualPreview>('/control/manual-preview',command);setPreview({result,command:{...command,expectedRevision:result.expectedRevision,expectedMode:result.previousMode,expectedQuota:result.quota}});}
  catch(e){
   const target=e instanceof ApiError?({EXISTING_ACCOUNT:'email',PENDING_ACCESS:'email',INVALID_END:'end',TARIFF_UNAVAILABLE:'tariff'}[e.code]??''):'';
   mark(target,e instanceof Error?e.message:'Не удалось проверить изменения.');
  }finally{setBusy(false);}
 }
 async function apply(){
  if(!preview)return;
  setBusy(true);setError('');
  try{await api('/control/manual-access',preview.command);onDone(inviting?'Приглашение создано. Письмо в очереди.':'Изменения сохранены. Письмо в очереди.');}
  catch(e){mark('',e instanceof Error?e.message:'Не удалось сохранить.');}finally{setBusy(false);}
 }
 const termView=(cycle:ManualPreview['previous'])=>cycle?.indefinite?'Бессрочно':cycle?.accessEnd?'До '+time.format(cycle.accessEnd):'Срок не задан';
 return <OperationDialog compact title={preview?'Подтверждение изменений':inviting?'Выдать доступ по email':quota?'Настроить лимит Анализатора':'Изменить доступ'} onClose={()=>{if(!busy)onClose();}} footer={<>
  <button className={common.button} disabled={busy} onClick={()=>{if(preview){setPreview(null);setError('');}else onClose();}}>{preview?'Назад':'Отмена'}</button>
  {preview?<button className={mode==='end_now'?common.dangerButton:common.primaryButton} disabled={busy} onClick={()=>void apply()}>Подтвердить</button>:
   <button type="submit" form="admin-access-form" className={common.primaryButton} disabled={busy}>Продолжить</button>}
 </>}>
 {preview&&<div className={styles.renewalBody}><p><strong>{preview.result.email}</strong></p>
  {inviting?<><p>Доступ · {termLabel(preview.result.term!)}{preview.result.term?.kind==='fixed'?' · '+time.format(preview.result.term.end):''}</p><p>Лимит · {quotaLabel(preview.result.quota)}</p></>:
   quota?<><p>Включено: {count(user?.analyzer?.units??0)} → {count(preview.result.quota.limit)} ед.</p>
   {preview.result.quota.source==='override'&&<><p>Уже использовано включённых: {count(user?.analyzer?.used??0)} ед. Останется: {count(Math.max(0,preview.result.quota.limit-(user?.analyzer?.used??0)))} ед.</p>{preview.result.next?.accessEnd&&<p>Ручной лимит до {time.format(preview.result.next.accessEnd)}.</p>}</>}{preview.result.effectiveAt&&<p>Вступит в силу после окончания оплаченного периода · {time.format(preview.result.effectiveAt)}.</p>}</>:
   <p>{termView(preview.result.previous)} → {termView(preview.result.next)}</p>}
  <p>{inviting?'Приглашение отправится на указанную почту.':'Пользователь получит письмо об изменении.'}</p>
  {error&&<p className={styles.error} role="alert">{error}</p>}
 </div>}
 <form style={preview?{display:'none'}:undefined} id="admin-access-form" className={styles.renewalBody} noValidate onSubmit={e=>{e.preventDefault();void check(new FormData(e.currentTarget));}}>
  {inviting?<OperationField label="Почта нового пользователя" error={fieldError('email')}><input name="email" type="email" maxLength={254} onChange={()=>setError('')}/></OperationField>:<p><strong>{user?.email}</strong></p>}
  {!inviting&&!quota&&<OperationField label="Действие"><SelectField value={mode} onChange={e=>{setMode(e.target.value as ManualCommand['mode']);setError('');}}>
   {!user?.cycle?.indefinite&&<option value="extend">Добавить период</option>}<option value="set_end">Изменить дату окончания</option>{!user?.cycle?.indefinite&&<option value="indefinite">Сделать бессрочным</option>}{user?.cycle&&<option value="end_now">Завершить доступ сейчас</option>}
  </SelectField></OperationField>}
  {duration&&<OperationField label="Период доступа"><SelectField value={kind} onChange={e=>{setKind(e.target.value as ManualTerm['kind']);setError('');}}><option value="days">Дни</option><option value="calendar_months">Календарные месяцы</option>{inviting&&<><option value="fixed">До выбранной даты</option><option value="indefinite">Бессрочно</option></>}</SelectField></OperationField>}
  {showCount&&<OperationField label={kind==='days'?'Количество дней':'Количество месяцев'} error={fieldError('count')}><input name="count" inputMode="numeric" defaultValue="7" onChange={digits}/></OperationField>}
  {fixed&&<OperationField label={'Дата окончания · '+time.label} error={fieldError('end')}><input name="end" type="datetime-local" step="60" defaultValue={user?.cycle?.accessEnd?localAdminDate(Date.parse(user.cycle.accessEnd),time.zone):''} onChange={()=>setError('')}/></OperationField>}
  {needsQuota&&<><OperationField label="Политика лимита"><SelectField value={policy} onChange={e=>{setPolicy(e.target.value as typeof policy);setError('');}}><option value="tariff">Взять из тарифа</option><option value="units">Задать в единицах</option><option value="rubles">Пересчитать из рублей</option></SelectField></OperationField>
   {policy==='tariff'?<OperationField label="Тариф для лимита" error={fieldError('tariff')}><SelectField name="tariff" defaultValue={(user?.cycle?.quotaPolicy?.source==='tariff'?user.cycle.quotaPolicy.tariffId:null)??data.tariffs[0]?.id??''}>{data.tariffs.map(t=><option key={t.id} value={t.id}>{catalogDurationLabel(t.duration)} · {count(t.aiQuota)} ед. · {moneyLabel(t.priceMinor)}</option>)}</SelectField></OperationField>:
    <OperationField label={policy==='rubles'?'Сумма, ₽ (1 ₽ = 100 единиц)':'Лимит, единиц'} error={fieldError('budget')}><input key={policy} name="budget" inputMode="numeric" defaultValue={policy==='rubles'?String(Math.floor((user?.analyzer?.units??10000)/100)):String(user?.analyzer?.units??10000)} onChange={digits}/></OperationField>}
  </>}
  <OperationField label="Заметка" error={fieldError('note')}><textarea name="note" rows={2} maxLength={1000} onChange={()=>setError('')}/></OperationField>
  {inviting&&<details open={field==='hours'||undefined}><summary>Дополнительные параметры</summary><OperationField label="Срок ссылки, часов" error={fieldError('hours')}><input name="hours" inputMode="numeric" defaultValue="72" onChange={digits}/></OperationField></details>}
  {!preview&&!field&&error&&<p className={styles.error} role="alert">{error}</p>}
 </form>
 </OperationDialog>;
}
