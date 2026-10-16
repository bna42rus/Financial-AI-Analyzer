import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, ClipboardList, Clock3, CreditCard, History, LayoutDashboard, Mail, Moon, Search, ShieldCheck, Sun, X } from 'lucide-react';
import { changeInvitation, dateLabel, durationLabel, emptyAccessStore, invitationLabel, invitationStatus, moneyFromRubles, moneyLabel, receivedMinor, requestStatus, reviewRequest, rublesFromMinor, statusLabel } from '../../../packages/access/src/model';
import type { AccessRequest, AccessStore, Invitation, ReviewCommand } from '../../../packages/access/src/model';
import { demoTariffs, seedAccessExample } from '../../../packages/access/src/demo';
import styles from './AdminApp.module.css';

type Section = 'dashboard' | 'requests' | 'renewals' | 'payments' | 'invitations' | 'history';
const sections = [
  { id: 'dashboard', label: 'Обзор', icon: LayoutDashboard },
  { id: 'requests', label: 'Заявки на доступ', icon: ClipboardList },
  { id: 'renewals', label: 'Продления', icon: Clock3 },
  { id: 'payments', label: 'Оплаты', icon: CreditCard },
  { id: 'invitations', label: 'Приглашения', icon: Mail },
  { id: 'history', label: 'История действий', icon: History },
] as const;
const actionLabel = { payment_confirmed: 'Оплата подтверждена', topup_requested: 'Запрошена доплата', request_rejected: 'Заявка отклонена', custom_period_granted: 'Согласован отдельный период', invitation_cancelled: 'Приглашение отменено', invitation_reissued: 'Подготовлено новое приглашение' };
const currentSection = (): Section => sections.find(s => '#' + s.id === location.hash)?.id ?? 'dashboard';
function inputDate(value: string) { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className={styles.empty}><ClipboardList size={32} aria-hidden="true"/><h2>{title}</h2><p>{children}</p></div>; }
function Badge({ value, children }: { value: string; children: ReactNode }) { return <span className={styles.badge} data-state={value}>{children}</span>; }
function Modal({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) {
  const opener=useRef<HTMLElement|null>(null), sourceHash=useRef(location.hash);
  return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal><Dialog.Overlay className={styles.overlay}/><Dialog.Content className={styles.modal} onOpenAutoFocus={()=>{opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;}} onCloseAutoFocus={event=>{event.preventDefault();if(sourceHash.current===location.hash&&opener.current?.isConnected)opener.current.focus();else document.getElementById('main-content')?.focus();}}>
    <header className={styles.modalHeader}><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close className={styles.iconButton} aria-label="Закрыть окно"><X size={20} aria-hidden="true"/></Dialog.Close></header>
    <div className={styles.modalBody}>{children}</div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function AdminApp() {
  const [section, setSection] = useState<Section>(currentSection);
  const [store, setStore] = useState<AccessStore>(emptyAccessStore);
  const [demo, setDemo] = useState(false), [dark, setDark] = useState(false);
  const [search, setSearch] = useState(''), [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [invitationAction, setInvitationAction] = useState<{ id: string; decision: 'cancel' | 'reissue' } | null>(null);
  const [now, setNow] = useState(()=>new Date().toISOString()), [notice, setNotice] = useState('');
  useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';},[dark]);
  useEffect(()=>{const restore=()=>{setSection(currentSection());setSelected(null);setInvitationAction(null);};window.addEventListener('hashchange',restore);window.addEventListener('popstate',restore);const timer=setInterval(()=>setNow(new Date().toISOString()),30000);return()=>{window.removeEventListener('hashchange',restore);window.removeEventListener('popstate',restore);clearInterval(timer);};},[]);
  function navigate(next: Section) { setSection(next); setSelected(null); setInvitationAction(null); if(location.hash!=='#'+next)history.pushState(null,'','#'+next); }
  function showExample() { const time=new Date().toISOString();setNow(time);setStore(seedAccessExample(time));setDemo(true);setSearch('');setStatus('all');setNotice(''); }
  function clearExample() { setStore(emptyAccessStore());setDemo(false);setSearch('');setStatus('all');setSelected(null);setInvitationAction(null);setNotice(''); }
  const rows = useMemo(()=>store.requests.filter(r=>{
    const match=[r.name,r.email,r.senderName,r.senderBank].join(' ').toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU'));
    return match && (status==='all'||requestStatus(r,now)===status);
  }),[store.requests,search,status,now]);
  const reviewing=store.requests.filter(r=>['under_review','needs_topup'].includes(requestStatus(r,now))).length;
  const paid=store.purchases.length, invitations=store.invitations.filter(i=>invitationStatus(i,now)==='active').length;
  const request=store.requests.find(r=>r.id===selected);
  const selectedInvite=store.invitations.find(i=>i.id===invitationAction?.id);
  const title=sections.find(s=>s.id===section)!.label;
  return <div className={styles.app}>
    <a href="#main-content" className={styles.skip}>Перейти к содержимому</a>
    <header className={styles.header}><div className={styles.brand}><ShieldCheck size={27} aria-hidden="true"/><div>Финансовый анализатор<span>Администрирование</span></div></div><div className={styles.headerActions}><span className={styles.previewLabel}>Первая версия интерфейса</span><button className={styles.iconButton} onClick={()=>setDark(v=>!v)} aria-label={dark?'Включить светлую тему':'Включить тёмную тему'}>{dark?<Sun size={18} aria-hidden="true"/>:<Moon size={18} aria-hidden="true"/>}</button></div></header>
    <div className={styles.workspace}><nav className={styles.nav} aria-label="Разделы админки">{sections.map(s=><a href={'#'+s.id} key={s.id} aria-current={section===s.id?'page':undefined} onClick={event=>{event.preventDefault();navigate(s.id);}}><s.icon size={18} aria-hidden="true"/>{s.label}{s.id==='requests'&&demo&&<span>{reviewing}</span>}</a>)}<div className={styles.navNote}><ShieldCheck size={18} aria-hidden="true"/><p>Отдельный административный интерфейс. Финансовые операции и чаты клиентов здесь недоступны.</p></div></nav>
      <main id="main-content" className={styles.main} tabIndex={-1}>
        <div className={styles.title}><div><span className={styles.eyebrow}>Управление доступом</span><h1>{title}</h1><p>{section==='requests'?'Новые пользователи: сверка оплаты и подготовка приглашений.':section==='payments'?'Журнал вручную сверенных переводов.':section==='invitations'?'Срок ссылки и оплаченный период учитываются отдельно.':section==='history'?'Изменения доступа, оплат и приглашений.':section==='renewals'?'Продления существующих аккаунтов — отдельный процесс.':'Заявки, оплаты и приглашения в одном месте.'}</p></div>{demo&&<button className={styles.secondary} onClick={clearExample}>Закрыть пример</button>}</div>
        <div className={styles.demoBanner}><ShieldCheck size={19} aria-hidden="true"/><div><strong>{demo?'Вы смотрите тестовые данные':'Предварительный просмотр админки'}</strong><p>Вход с TOTP, сервер и почта ещё не подключены. Действия в примере меняют только данные в памяти этой страницы.</p></div>{!demo&&<button className={styles.primary} onClick={showExample}>Открыть пример</button>}</div>
        {notice&&<div className={styles.notice} role="status">{notice}</div>}
        {!demo?<Empty title="Админка готова для просмотра на примере">Нажмите «Открыть пример», чтобы проверить очередь заявок, сверку оплаты, приглашения и историю. Реальные пользователи пока не подключены.</Empty>:
          section==='dashboard'?<>
            <div className={styles.stats}>{[{label:'Заявки на проверке',value:reviewing,target:'requests' as Section},{label:'Оплачено, ждут регистрации',value:paid,target:'requests' as Section},{label:'Приглашения подготовлены',value:invitations,target:'invitations' as Section}].map(s=><button key={s.label} onClick={()=>{setStatus(s.target==='requests'&&s.label.startsWith('Оплачено')?'paid_not_activated':'all');navigate(s.target);}}><span>{s.label}</span><strong>{s.value}</strong><ArrowRight size={18} aria-hidden="true"/></button>)}</div>
            <section className={styles.panel}><div className={styles.panelTitle}><h2>Нужна ручная проверка</h2><button className={styles.textButton} onClick={()=>{setStatus('all');navigate('requests');}}>Все заявки <ArrowRight size={15} aria-hidden="true"/></button></div><RequestList rows={store.requests.filter(r=>['under_review','needs_topup'].includes(requestStatus(r,now)))} now={now} onOpen={setSelected}/></section>
            <section className={styles.panel}><h2>Последние действия</h2><AuditList store={store}/></section>
          </>:section==='requests'?<>
            <div className={styles.filters}><label><span>Поиск заявки</span><div className={styles.search}><Search size={17} aria-hidden="true"/><input aria-label="Поиск заявки" placeholder="Имя, почта или банк отправителя" value={search} maxLength={300} onChange={e=>setSearch(e.target.value)}/></div></label><label>Статус<select value={status} onChange={e=>setStatus(e.target.value)}><option value="all">Все статусы</option>{Object.entries(statusLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
            <section className={styles.panel}><div className={styles.panelTitle}><h2>Заявки новых пользователей</h2><span className={styles.muted}>{rows.length} из {store.requests.length}</span></div>{rows.length?<RequestList rows={rows} now={now} onOpen={setSelected}/>:<Empty title="Заявки не найдены">Измените поиск или статус. Исходные заявки сохраняются.</Empty>}</section>
          </>:section==='renewals'?<Empty title="Продления подключим следующим блоком">Заявки новых пользователей находятся в отдельном разделе. Продление активного доступа и восстановление истёкшего будут учитывать разные точки начала периода.</Empty>:section==='payments'?<section className={styles.panel}><div className={styles.panelTitle}><h2>Ручные платежи</h2><span className={styles.muted}>{store.payments.length} записей</span></div><div className={styles.info}>Журнал фиксирует результат ручной сверки. Перевод и денежный возврат выполняются вне сервиса. Исправления и возвраты подключим отдельными действиями.</div>{store.payments.length?<div className={styles.records}>{[...store.payments].reverse().map(p=><article className={styles.record} key={p.id}><div><strong>{store.requests.find(r=>r.id===p.requestId)?.email}</strong><p>{p.senderName} · {p.senderBank}</p></div><div className={styles.amount}><strong>{moneyLabel(p.actualMinor)}</strong><span>Тариф заявки: {moneyLabel(p.expectedMinor)}</span></div><div><Badge value={p.disposition}>{p.disposition==='return_required'?'Требуется ручной возврат':'Учтено'}</Badge><p>{dateLabel(p.receivedAt)}</p></div><button className={styles.secondary} onClick={()=>setSelected(p.requestId)}>Заявка</button></article>)}</div>:<Empty title="Платежей пока нет">После сверки оплаты отдельные переводы появятся в этом журнале.</Empty>}</section>:section==='invitations'?<section className={styles.panel}><div className={styles.panelTitle}><h2>Приглашения и оплаченный доступ</h2><span className={styles.muted}>{store.invitations.length} записей</span></div><div className={styles.info}>В примере хранится подготовка приглашения. Безопасная ссылка и отправка письма будут подключены после серверной авторизации. Истечение или отмена приглашения сохраняют подтверждённую оплату.</div>{store.invitations.length?<div className={styles.records}>{[...store.invitations].reverse().map(i=>{
            const state=invitationStatus(i,now), purchase=store.purchases.find(p=>p.id===i.purchaseId)!, latest=store.invitations.filter(x=>x.purchaseId===i.purchaseId).at(-1)?.id===i.id;
            return <article className={styles.record} key={i.id}><div><strong>{i.email}</strong><p>{durationLabel(purchase.duration)} с активации</p></div><div><Badge value={state}>{invitationLabel[state]}</Badge><p>Срок ссылки до {dateLabel(i.expiresAt)}</p><span className={styles.muted}>Письмо не отправлено</span></div><div className={styles.recordActions}>{latest&&<><button className={styles.secondary} onClick={()=>setInvitationAction({id:i.id,decision:'reissue'})}>Подготовить новое</button>{state==='active'&&<button className={styles.textButton} onClick={()=>setInvitationAction({id:i.id,decision:'cancel'})}>Отменить</button>}</>}<button className={styles.textButton} onClick={()=>setSelected(i.requestId)}>Заявка</button></div></article>;
          })}</div>:<Empty title="Приглашений пока нет">После подтверждения оплаты будет подготовлено приглашение для регистрации.</Empty>}</section>:<section className={styles.panel}><h2>История административных действий</h2><AuditList store={store}/></section>
        }
        <footer className={styles.footer}>Тарифы и лимиты в примере — тестовые. Полная админка, регистрация и серверные проверки прав разрабатываются поэтапно.</footer>
      </main>
    </div>
    {request&&<RequestDialog request={request} store={store} now={now} onClose={()=>setSelected(null)} onConfirm={cmd=>{setStore(current=>reviewRequest(current,cmd,new Date().toISOString()));setNotice(cmd.decision==='topup'?'В примере записан платёж и запрос доплаты.':cmd.decision==='reject'?'Заявка отклонена в примере. Запись не выполняет денежный возврат.':'Оплата подтверждена в примере. Приглашение подготовлено, оплаченный период ещё не начался.');}}/>}
    {selectedInvite&&invitationAction&&<InvitationDialog invite={selectedInvite} decision={invitationAction.decision} onClose={()=>setInvitationAction(null)} onConfirm={reason=>{const command={actionId:crypto.randomUUID(),invitationId:selectedInvite.id,decision:invitationAction.decision,actorId:'demo-owner',reason};setStore(current=>changeInvitation(current,command,new Date().toISOString()));setNotice(invitationAction.decision==='cancel'?'Приглашение отменено в примере. Оплата сохранена.':'Новое приглашение подготовлено в примере. Письмо не отправлялось.');setInvitationAction(null);}}/>}
  </div>;
}

function RequestList({ rows, now, onOpen }: { rows: AccessRequest[]; now: string; onOpen: (id: string)=>void }) {
  return <div className={styles.requestList}><div className={styles.tableHead}><span>Пользователь</span><span>Тариф заявки</span><span>Статус</span><span>Оплата отмечена</span><span/></div>{rows.map(r=><article className={styles.requestRow} key={r.id}><div><strong>{r.name}</strong><p>{r.email}</p></div><div><strong>{moneyLabel(r.tariff.priceMinor)}</strong><p>{durationLabel(r.tariff.duration)}</p></div><div><Badge value={requestStatus(r,now)}>{statusLabel[requestStatus(r,now)]}</Badge>{r.senderBank&&<p>{r.senderBank}</p>}</div><div className={styles.timestamp}><span className={styles.mobileLabel}>Оплата отмечена</span>{dateLabel(r.claimedAt)}</div><button className={styles.secondary} onClick={()=>onOpen(r.id)} aria-label={'Открыть заявку '+r.name}>Открыть</button></article>)}</div>;
}
function AuditList({ store }: { store: AccessStore }) { return store.audit.length?<ol className={styles.audit}>{[...store.audit].reverse().map(a=><li key={a.id}><History size={17} aria-hidden="true"/><div><strong>{actionLabel[a.action]}</strong><p>{store.requests.find(r=>r.id===a.requestId)?.email} · Администратор примера</p>{a.reason&&<p>{a.reason}</p>}</div><time dateTime={a.at}>{dateLabel(a.at)}</time></li>)}</ol>:<Empty title="Действий пока нет">Изменения оплат и приглашений будут сохранены в этой истории.</Empty>; }

function RequestDialog({ request, store, now, onClose, onConfirm }: { request: AccessRequest; store: AccessStore; now: string; onClose: ()=>void; onConfirm: (cmd: ReviewCommand)=>void }) {
  const [actual,setActual]=useState(()=>{const rest=BigInt(request.tariff.priceMinor)-BigInt(receivedMinor(store,request.id));return rublesFromMinor((rest>0n?rest:0n).toString());});
  const [receivedAt,setReceivedAt]=useState(()=>inputDate(request.claimedAt??now));
  const [choice,setChoice]=useState<ReviewCommand['decision']|'none'>('none'), [reason,setReason]=useState(''), [days,setDays]=useState('');
  const [preview,setPreview]=useState<ReviewCommand|null>(null), [error,setError]=useState('');
  useEffect(()=>{const rest=BigInt(request.tariff.priceMinor)-BigInt(receivedMinor(store,request.id));setActual(rublesFromMinor((rest>0n?rest:0n).toString()));setChoice('none');setReason('');setPreview(null);setError('');},[request.revision,request.id]);
  let incoming: string | null=null;try{incoming=moneyFromRubles(actual);}catch{ /* Form error appears on preview. */ }
  const previously=receivedMinor(store,request.id);
  let total:string|null=null;
  if(incoming!==null){try{const value=(BigInt(previously)+BigInt(incoming)).toString();moneyLabel(value);total=value;}catch{/* Reject aggregate overflow before showing a preview. */}}
  const equal=total===request.tariff.priceMinor;
  const eligible=['under_review','needs_topup'].includes(requestStatus(request,now));
  const purchase=store.purchases.find(p=>p.requestId===request.id);
  function prepare(event: FormEvent) {
    event.preventDefault();try {
      if(incoming===null)moneyFromRubles(actual);
      if(total===null)throw new Error('Проверьте сумму перевода: значение слишком велико');
      if(!equal&&choice==='none')throw new Error('Выберите решение для суммы, отличающейся от тарифа');
      const cmd: ReviewCommand={actionId:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision,actorId:'demo-owner',actualMinor:incoming!,receivedAt:new Date(receivedAt).toISOString(),decision:equal?'confirm':choice as ReviewCommand['decision'],reason,...(choice==='custom'?{customDays:Number(days)}:{})};
      reviewRequest(store,cmd,new Date().toISOString());setPreview(cmd);setError('');
    } catch(e) { setError(e instanceof Error?e.message:'Проверьте данные сверки'); }
  }
  return <Modal title={'Заявка '+request.name} description="Тестовая карточка · новая регистрация" onClose={onClose}>
    <Badge value={requestStatus(request,now)}>{statusLabel[requestStatus(request,now)]}</Badge>
    <div className={styles.detailGrid}><section><h3>Пользователь</h3><dl><div><dt>Почта</dt><dd>{request.email}</dd></div><div><dt>Создана</dt><dd>{dateLabel(request.createdAt)}</dd></div><div><dt>Почта подтверждена в примере</dt><dd>{dateLabel(request.verifiedAt)}</dd></div><div><dt>Оплата отмечена</dt><dd>{dateLabel(request.claimedAt)}</dd></div><div><dt>Отправитель</dt><dd>{request.senderName||'Не указан'}</dd></div><div><dt>Банк отправителя</dt><dd>{request.senderBank||'Не указан'}</dd></div></dl></section><section><h3>Сохранённые условия заявки</h3><div className={styles.detailPrice}>{moneyLabel(request.tariff.priceMinor)}</div><p>{durationLabel(request.tariff.duration)} с активации</p><p>{request.tariff.aiQuota} запросов к Анализатору в примере</p><div className={styles.info}>Цена каталога сейчас: {moneyLabel(demoTariffs.find(t=>t.id===request.tariff.id)?.priceMinor??request.tariff.priceMinor)}. Условия созданной заявки сохраняются.</div></section></div>
    {!request.claimedAt&&<div className={styles.info}>Срок неоплаченной заявки: до {dateLabel(request.expiresAt)}.</div>}
    {request.claimedAt&&eligible&&<div className={styles.info}>После отметки оплаты заявка не истекает автоматически. Выдача доступа начнётся с регистрации и активации аккаунта.</div>}
    {purchase&&<div className={styles.info}><strong>Оплата подтверждена в примере</strong><p>{moneyLabel(purchase.actualMinor)} · {durationLabel(purchase.duration)}. Приглашение подготовлено. Аккаунт пока не зарегистрирован; срок доступа ещё не отсчитывается.</p></div>}
    {request.decisionNote&&<p className={styles.reason}>Причина решения: {request.decisionNote}</p>}
    {eligible&&(preview?<section className={styles.preview} aria-label="Последствия решения"><h3>Проверьте решение перед подтверждением</h3><dl><div><dt>Новый полученный перевод</dt><dd>{moneyLabel(preview.actualMinor)}</dd></div><div><dt>Всего учтено по заявке</dt><dd>{moneyLabel(total!)}</dd></div><div><dt>Результат</dt><dd>{preview.decision==='topup'?'Запросить доплату':preview.decision==='reject'?'Отклонить заявку':preview.decision==='custom'?`Выдать ${preview.customDays} дней с активации`:`Выдать ${durationLabel(request.tariff.duration)} с активации`}</dd></div></dl>{preview.reason&&<p>Причина: {preview.reason}</p>}<p className={styles.muted}>{preview.decision==='reject'?'Денежный возврат будет выполнен вручную вне сервиса.':'Письмо не отправляется. Доступ в реальном сервисе не создаётся.'}</p><div className={styles.actions}><button className={styles.secondary} onClick={()=>setPreview(null)}>Назад к сверке</button><button className={styles.primary} onClick={()=>{try{onConfirm(preview);setPreview(null);setError('');}catch(e){setError(e instanceof Error?e.message:'Заявка изменилась');}}}>Подтвердить решение в примере</button></div></section>:<form className={styles.review} onSubmit={prepare}><h3>Сверка ручного перевода</h3>{BigInt(previously)>0n&&<p>Уже учтено: <strong>{moneyLabel(previously)}</strong>. Укажите сумму следующего перевода, чтобы сохранить его отдельно.</p>}<div className={styles.formGrid}><label>Получено по этому переводу, ₽<input inputMode="decimal" value={actual} onChange={e=>{setActual(e.target.value);setChoice('none');}} required autoComplete="off" maxLength={24}/></label><label>Дата и время получения<input type="datetime-local" value={receivedAt} onChange={e=>setReceivedAt(e.target.value)} required/></label></div><p className={styles.muted}>Время показано в часовом поясе этого браузера: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>{total!==null&&<div className={styles.total}>Всего учтено по заявке <strong>{moneyLabel(total)}</strong><span>Ожидалось {moneyLabel(request.tariff.priceMinor)}</span></div>}
      {!equal&&total!==null&&<fieldset className={styles.decisions}><legend>Сумма отличается от тарифа — выберите решение</legend>{[{value:'accept_full',label:'Принять сумму за полный тариф'},{value:'topup',label:'Запросить доплату'},{value:'reject',label:'Отклонить заявку / оформить возврат отдельно'},{value:'custom',label:'Выдать отдельно согласованный период'}].filter(c=>c.value!=='topup'||BigInt(total)<BigInt(request.tariff.priceMinor)).map(c=><label key={c.value}><input type="radio" name="decision" checked={choice===c.value} onChange={()=>setChoice(c.value as ReviewCommand['decision'])}/>{c.label}</label>)}</fieldset>}
      {choice==='custom'&&!equal&&<label>Согласованный период, дней<input type="number" min={1} step={1} value={days} onChange={e=>setDays(e.target.value)} required/></label>}
      <label>Причина решения / внутренняя заметка<textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000} required={total!==null&&!equal} rows={3} placeholder={equal?'Необязательно при точном совпадении суммы':'Обязательно для отдельного решения'}/></label><button className={styles.primary}>Показать последствия</button>
    </form>)}
    {!eligible&&!purchase&&<div className={styles.info}>{request.status==='rejected'?'Заявка закрыта. Финансовый возврат отражается отдельной записью и выполняется вручную.':'Сверка станет доступна после подтверждения почты и отметки оплаты пользователем.'}</div>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}
  </Modal>;
}

function InvitationDialog({invite,decision,onClose,onConfirm}:{invite:Invitation;decision:'cancel'|'reissue';onClose:()=>void;onConfirm:(reason:string)=>void}) {
  const [reason,setReason]=useState('');
  return <Modal title={decision==='cancel'?'Отменить приглашение':'Подготовить новое приглашение'} description={invite.email} onClose={onClose}><div className={styles.info}>Подтверждённая оплата и право на оплаченный период сохраняются. Новая ссылка будет иметь отдельный срок действия. Отправка писем в примере не выполняется.</div><form onSubmit={e=>{e.preventDefault();onConfirm(reason);}}><label>Причина<textarea required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} rows={3}/></label><div className={styles.actions}><button type="button" className={styles.secondary} onClick={onClose}>Назад</button><button className={styles.primary}>Подтвердить в примере</button></div></form></Modal>;
}
