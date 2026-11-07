import {useMailCooldown,mailAddressKey} from './use-mail-cooldown';
import type {MailSend} from './use-mail-cooldown';
import {useCallback,useEffect,useState} from 'react';
import {ArrowRight,CalendarDays,CheckCircle2,CreditCard,LockKeyhole,Mail,ShieldCheck,X} from 'lucide-react';
import {OperationDialog,OperationField} from './OperationDialog';
import {LegalFooter,LegalUpdate,usePublicTariffs} from './LegalPages';
import {legalDocuments} from '../../../packages/access/src/legal';
import {Brand} from './Brand';
import {SupportLink} from './SupportDialog';
import {api,ApiError,readLink} from './server-client';
import type {Session} from './server-client';
import {ServerAccount} from './ServerAccount';
import {ServerRenewal} from './ServerRenewal';
import {FirstAccessBilling,FirstPaidRenewal} from './AccessBilling';
import {ServerAuth} from './ServerAuth';
import {ServerFinance} from './ServerFinance';
import {durationLabel,moneyLabel,statusLabel} from '../../../packages/access/src/model';
import type {AccessRequest} from '../../../packages/access/src/model';
import styles from './ServerAccess.module.css';

const initialLink=readLink();
const getRoute=()=>location.hash.slice(1).split('?')[0]??'';
const isPublic=(route:string)=>['account','access','invite','reset','verify','login'].includes(route);
const hasCode=(e:unknown,...codes:string[])=>e instanceof ApiError&&codes.includes(e.code);
function setRouteHash(route:string,replace=false){if(replace){history.replaceState(null,'','#'+route);window.dispatchEvent(new Event('hashchange'));}else location.hash='#'+route;}
function AccessCard({icon:Icon,title,children}:{icon:typeof Mail;title:string;children:React.ReactNode}){
 return <section className={styles.card+' '+styles.entryCard}><div className={styles.entryIcon}><Icon size={22}/></div><h1>{title}</h1>{children}</section>;
}

export function ServerAccess(){
 const [route,setRoute]=useState(getRoute),[link,setLink]=useState(initialLink),[session,setSession]=useState<Session|null>(null),[loaded,setLoaded]=useState(false),[sessionError,setSessionError]=useState('');
 const [row,setRow]=useState<AccessRequest|null>(null),[applicationLoaded,setApplicationLoaded]=useState(false),[applicationError,setApplicationError]=useState('');
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[submittedEmail,setSubmittedEmail]=useState(''),[linkInvalid,setLinkInvalid]=useState(false);
 const [accountOpen,setAccountOpen]=useState(false),[renewalOpen,setRenewalOpen]=useState(false),[dismissed,setDismissed]=useState<string|null>(null),[registrationCodeSent,setRegistrationCodeSent]=useState(false);
 const [applicationEmail,setApplicationEmail]=useState('');
 const registrationMail=useMailCooldown(link.token),applicationMail=useMailCooldown(mailAddressKey(applicationEmail));
 async function sendRegistrationCode(){
  try{registrationMail.remember(await api<MailSend>('/access/registration-proof',{invitationToken:link.token}));}
  catch(e){registrationMail.remember(e);throw e;}
 }
 const publicCatalog=usePublicTariffs(),tariffs=publicCatalog.tariffs??[];
 const [tariffId,setTariffId]=useState(()=>new URLSearchParams(location.hash.split('?')[1]).get('tariff')??'');
 const selected=tariffs.find(t=>t.id===tariffId)??tariffs[0];
 const renewalTariff=route==='access'?new URLSearchParams(location.hash.split('?')[1]).get('tariff')??'':'';
 const refresh=useCallback(async()=>{try{setSession(await api<Session>('/session',undefined,AbortSignal.timeout(10000)));setSessionError('');}catch(e){if(hasCode(e,'AUTH_REQUIRED')){setSession(null);setSessionError('');}else{setSessionError('Не удалось проверить доступ. Проверьте соединение и повторите.');throw e;}}finally{setLoaded(true);}},[]);
 const reloadApplication=useCallback(async()=>{try{setRow((await api<{request:AccessRequest}>('/access/request')).request);setApplicationError('');}catch(e){if(hasCode(e,'APPLICATION_SESSION_REQUIRED')){setRow(null);setApplicationError('');}else{setApplicationError('Не удалось загрузить заявку. Повторите проверку.');throw e;}}finally{setApplicationLoaded(true);}},[]);
 useEffect(()=>{
  void refresh().catch(()=>{});void reloadApplication().catch(()=>{});
  const change=()=>{setRoute(getRoute());setTariffId(new URLSearchParams(location.hash.split('?')[1]).get('tariff')??'');setLink(readLink());setError('');setMessage('');setLinkInvalid(false);setRegistrationCodeSent(false);
   if(getRoute()==='account'&&new URLSearchParams(location.hash.split('?')[1]).has('payment'))setRenewalOpen(true);
  };
  if(getRoute()==='account'&&new URLSearchParams(location.hash.split('?')[1]).has('payment'))setRenewalOpen(true);
  window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);
 },[refresh,reloadApplication]);
 useEffect(()=>{if(!session)return;const tick=()=>{if(document.visibilityState!=='hidden')void refresh().catch(()=>{});};const t=window.setInterval(tick,60000);window.addEventListener('focus',tick);return()=>{window.clearInterval(t);window.removeEventListener('focus',tick);};},[!!session,refresh]);
 useEffect(()=>{if(!row||!['under_review','needs_topup','paid_not_activated','awaiting_payment'].includes(row.status)||route!=='access')return;
  const tick=()=>{if(document.visibilityState!=='hidden')void reloadApplication().catch(()=>{});};
  const t=window.setInterval(tick,15000);window.addEventListener('focus',tick);return()=>{window.clearInterval(t);window.removeEventListener('focus',tick);};
 },[row?.id,row?.status,route,reloadApplication]);
 async function run(work:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setMessage('');try{await work();}catch(e){if(hasCode(e,'INVALID_TOKEN','INVALID_INVITATION'))setLinkInvalid(true);else setError(e instanceof Error?e.message:'Не удалось выполнить действие.');}finally{setBusy(false);}}
 function signOut(){void run(async()=>{await api('/auth/sign-out',{});setAccountOpen(false);setRenewalOpen(false);setSession(null);setDismissed(null);setRouteHash('login');});}
 function enter(){setAccountOpen(false);setRouteHash('overview');}
 const showFinance=loaded&&session?.scope==='active'&&(!isPublic(route)||!!renewalTariff);
 const closeRenewal=()=>{setRenewalOpen(false);if(renewalTariff)setRouteHash(session?.scope==='active'?'overview':'account',true);else if(getRoute()==='account'&&location.hash.includes('payment='))setRouteHash('account',true);void refresh().catch(()=>{});};
 const renewal=(renewalOpen||!!renewalTariff)&&session&&!session.blocked&&<OperationDialog compact footer={null} title="Продление доступа" onClose={closeRenewal}><ServerRenewal embedded onRefresh={refresh} initialTariffId={renewalTariff}/></OperationDialog>;
 if(showFinance&&session)return <><LegalUpdate signedIn/>{session.accessWarning&&dismissed!==session.accessWarning&&<div className={styles.warningBar}><span role="status">{session.accessWarning}</span><button className={styles.secondary} onClick={()=>setRenewalOpen(true)}>Продлить доступ</button><button className={styles.dismissWarning} aria-label="Скрыть уведомление" onClick={()=>setDismissed(session.accessWarning??null)}><X size={17}/></button></div>}<ServerFinance session={session} onAccount={()=>{setError('');setAccountOpen(true);}} onAccessLost={()=>{setAccountOpen(false);setSession(s=>s?{...s,scope:'restricted'}:null);setRouteHash('account');void refresh().catch(()=>{});}}/>{accountOpen&&<ServerAccount asDialog session={session} accountError={error} busy={busy} refresh={refresh} signOut={signOut} back={()=>setAccountOpen(false)}/>} {renewal}</>;
 const returning=route==='access'&&new URLSearchParams(location.hash.split('?')[1]).has('payment');
 const restartApplication=()=>{setRow(null);setSubmittedEmail('');setLinkInvalid(false);setRouteHash('access',true);};
 const notices=<>{error&&<p role="alert" className={styles.error}>{error}</p>}{message&&<p role="status" className={styles.success}>{message}</p>}</>;
 return <div className={styles.page+' '+styles.entryPage}><header className={styles.header}><a className={styles.brand} href={session?'#overview':'#'} aria-label="CashNeuro"><Brand/></a><nav className={styles.entryNav} aria-label="Доступ">{session?<><SupportLink className={styles.secondary}/><button className={styles.secondary} disabled={busy} onClick={signOut}>Выйти</button></>:<><a href="/price">Тарифы</a><a className={styles.secondary} href="#login">Войти</a></>}</nav></header>
 {!loaded?<AccessCard icon={ShieldCheck} title="Проверяем вход"><p role="status">Открываем CashNeuro…</p></AccessCard>:
 sessionError&&!session?<AccessCard icon={ShieldCheck} title="CashNeuro недоступен"><p role="alert">{sessionError}</p><button className={styles.primary} onClick={()=>void refresh().catch(()=>{})}>Повторить</button></AccessCard>:
 session?<><LegalUpdate signedIn/>{notices}{session.scope==='restricted'&&!accountOpen?<AccessCard icon={LockKeyhole} title={session.blocked?'Доступ приостановлен':session.accessEnd?'Срок доступа закончился':'Доступ ещё не активен'}>
  <p>{session.blocked?'Чтобы узнать причину и восстановить доступ, напишите в поддержку.':session.accessEnd?'Продлите доступ, чтобы снова открыть операции, отчёты и Анализатор. Финансовые данные сохранены.':'Финансовые разделы откроются после подтверждения доступа.'}</p>
  <div className={styles.actions}>{session.blocked?<SupportLink className={styles.primary}>Написать в поддержку</SupportLink>:<button className={styles.primary} onClick={()=>setRenewalOpen(true)}>Продлить доступ</button>}<button className={styles.secondary} onClick={()=>setAccountOpen(true)}>Открыть аккаунт</button></div>
 </AccessCard>:<ServerAccount session={session} busy={busy} refresh={refresh} signOut={signOut} back={session.scope==='active'?enter:undefined}/>} {renewal}</>:
 route==='login'||route==='account'||(!isPublic(route)&&!!route)?<div className={styles.authWrap}>{notices}<ServerAuth onAuthenticated={async()=>{await refresh();if(route==='login')setRouteHash('',true);}}/><p className={styles.entryFootnote}>Ещё нет аккаунта? <a href="#access">Получить доступ</a></p></div>:
 route==='invite'?<AccessCard icon={ShieldCheck} title={linkInvalid||!link.token?'Приглашение недоступно':'Создайте аккаунт'}>
  {notices}{linkInvalid||!link.token?<><p>Ссылка могла истечь или уже использоваться. Если вы оплатили доступ, попросите новую ссылку в поддержке.</p><div className={styles.actions}><a className={styles.primary} href="/contacts">Написать в поддержку</a><a className={styles.secondary} href="#login">Войти</a></div></>:<>
  <ol className={styles.registrationSteps}><li aria-current={registrationCodeSent?undefined:'step'}>1. Получить код</li><li aria-current={registrationCodeSent?'step':undefined}>2. Создать аккаунт</li></ol>
  {!registrationCodeSent?<><p>Отправим код на почту, на которую пришло приглашение.</p><div className={styles.actions}><button className={styles.primary} disabled={busy||registrationMail.seconds>0} onClick={()=>run(async()=>{await sendRegistrationCode();setRegistrationCodeSent(true);})}>{registrationMail.label??'Отправить код'}</button><button className={styles.secondary} disabled={busy} onClick={()=>{setError('');setRegistrationCodeSent(true);}}>У меня уже есть код</button></div></>:<form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void run(async()=>{await api('/access/register',{invitationToken:link.token,proofToken:String(data.get('proof')).trim(),name:String(data.get('name')).trim(),password:String(data.get('password')),termsVersion:legalDocuments.terms.version});setRouteHash('login',true);setMessage('Аккаунт создан. Войдите с новым паролем.');});}}>
   <OperationField label="Код из письма"><input name="proof" required autoComplete="one-time-code" maxLength={100}/></OperationField><OperationField label="Имя"><input name="name" autoComplete="name" required maxLength={100}/></OperationField><OperationField label="Пароль"><input name="password" type="password" required autoComplete="new-password" minLength={12} maxLength={128}/></OperationField>
   <p className={styles.muted}>Не менее 12 символов.</p><div className={styles.legalChoice}><input type="checkbox" name="terms" required id="registration-terms"/><label htmlFor="registration-terms">Принимаю <a href="/terms" target="_blank" rel="noreferrer">условия использования</a>.</label></div><p><a href="/privacy" target="_blank" rel="noreferrer">Политика обработки персональных данных</a></p><div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy||registrationMail.seconds>0} onClick={()=>run(async()=>{await sendRegistrationCode();setMessage('Запрошен новый код.');})}>{registrationMail.label??'Отправить код повторно'}</button><button className={styles.primary} disabled={busy}>Создать аккаунт</button></div>
  </form>}</>}
 </AccessCard>:
 route==='reset'?<AccessCard icon={LockKeyhole} title={linkInvalid||!link.token?'Ссылка на сброс недоступна':'Задайте новый пароль'}>{notices}
  {linkInvalid||!link.token?<><p>Запросите новую ссылку на странице входа.</p><a className={styles.primary} href="#login">На страницу входа</a></>:<form onSubmit={e=>{e.preventDefault();const d=new FormData(e.currentTarget);void run(async()=>{await api('/security/reset',{token:link.token,newPassword:String(d.get('password'))});setRouteHash('login',true);setMessage('Пароль изменён. Войдите с новым паролем.');});}}><label>Новый пароль<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128}/></label><p className={styles.muted}>Не менее 12 символов. Прежние сеансы завершатся.</p><button className={styles.primary} disabled={busy}>Сохранить пароль</button></form>}
 </AccessCard>:
 route==='verify'?<AccessCard icon={Mail} title={linkInvalid||!link.token?'Ссылка подтверждения недоступна':'Подтвердите почту'}>{notices}{linkInvalid||!link.token?<><p>Запросите новое письмо на тот же адрес, чтобы продолжить заявку.</p><button className={styles.primary} onClick={restartApplication}>Запросить новое письмо</button></>:<><p>Подтвердите адрес, чтобы открыть свою заявку и перейти к оплате.</p><button className={styles.primary} disabled={busy} onClick={()=>run(async()=>{await api('/access/verify',{token:link.token});await reloadApplication();setRouteHash('access',true);})}>Подтвердить почту</button></>}</AccessCard>:
 route==='access'?<>{notices}{!applicationLoaded?<AccessCard icon={CreditCard} title="Открываем заявку"><p role="status">Проверяем состояние доступа…</p></AccessCard>:
 applicationError?<AccessCard icon={CreditCard} title="Не удалось открыть заявку"><p role="alert">{applicationError}</p><button className={styles.primary} onClick={()=>void reloadApplication().catch(()=>{})}>Повторить</button></AccessCard>:
 row?<AccessCard icon={row.status==='paid_not_activated'?CheckCircle2:CreditCard} title={row.status==='awaiting_payment'?'Оплатите доступ':row.status==='paid_not_activated'?'Оплата подтверждена':statusLabel[row.status]}>
   <dl className={styles.checkoutFacts}><div><dt>Почта</dt><dd>{row.email}</dd></div><div><dt>Тариф</dt><dd>{row.tariff.name} · {durationLabel(row.tariff.duration)}</dd></div><div><dt>Стоимость</dt><dd>{moneyLabel(row.tariff.priceMinor)}</dd></div></dl>
   {['awaiting_payment','needs_topup'].includes(row.status)?<FirstAccessBilling row={row} onPaid={reloadApplication} onRestart={restartApplication} fallback={<>{row.remainingMinor&&<p>Осталось доплатить: {moneyLabel(row.remainingMinor)}.</p>}<p>Оплата через сайт сейчас недоступна.</p><a className={styles.secondary} href="/contacts">Связаться с поддержкой</a></>}/>:
   row.status==='paid_not_activated'?<><p>Откройте письмо с приглашением и создайте аккаунт. Оплаченный период начнётся после регистрации.</p><FirstPaidRenewal/><div className={styles.actions}><a href="#login" className={styles.primary}>Уже создали аккаунт? Войти</a><SupportLink className={styles.secondary}>Письмо не пришло</SupportLink></div></>:
   row.status==='rejected'?<><p>Платёж не подтверждён. Если деньги списались, обратитесь в поддержку.</p><SupportLink className={styles.primary}>Написать в поддержку</SupportLink></>:<p role="status">Проверяем платёж. После подтверждения пришлём приглашение. Повторно платить пока не нужно.</p>}
 </AccessCard>:
 submittedEmail?<AccessCard icon={Mail} title="Проверьте почту"><p>Если заявку можно продолжить, письмо придёт на <strong>{submittedEmail}</strong>. Откройте его и следуйте инструкции.</p><p>Проверьте также папку «Спам».</p><button className={styles.secondary} onClick={()=>setSubmittedEmail('')}>Изменить адрес или запросить снова</button></AccessCard>:
 <AccessCard icon={CalendarDays} title={returning?'Восстановите доступ к заявке':'Получить доступ'}>
  <p>{returning?'Не удалось открыть заявку после возврата с оплаты. Укажите ту же почту: пришлём ссылку для проверки заявки.':'Выберите период и подтвердите почту. После подтверждения оплаты пришлём приглашение для регистрации.'}</p>
  <form onSubmit={e=>{e.preventDefault();if(!selected||applicationMail.seconds)return;const d=new FormData(e.currentTarget),email=String(d.get('email')).trim();void run(async()=>{try{applicationMail.remember(await api<MailSend>('/access/requests',{name:String(d.get('name')),email,tariffId:selected.id,priceMinor:selected.priceMinor,catalogVersion:selected.catalogVersion??0,consentVersion:legalDocuments.consent.version}));setSubmittedEmail(email);}catch(e){applicationMail.remember(e);throw e;}});}}>
   <label>Период доступа<select name="tariff" value={selected?.id??''} onChange={e=>setTariffId(e.target.value)} required disabled={!tariffs.length}>{!tariffs.length&&<option value="">Нет доступных тарифов</option>}{tariffs.map(t=><option key={t.id} value={t.id}>{t.name} — {moneyLabel(t.priceMinor)}</option>)}</select></label>
   {publicCatalog.failed&&<p role="alert" className={styles.error}>Не удалось загрузить тарифы. <a href="/price">Открыть страницу тарифов</a></p>}{selected&&<p className={styles.muted}>{selected.aiQuota.toLocaleString('ru-RU')} единиц Анализатора {selected.duration.kind==='days'?'за период':'в месяц'}.</p>}
   <label>Имя<input name="name" required autoComplete="name" maxLength={100}/></label><label>Почта<input name="email" type="email" required autoComplete="email" maxLength={254} value={applicationEmail} onChange={e=>setApplicationEmail(e.target.value)}/></label><div className={styles.legalChoice}><input type="checkbox" name="consent" required id="application-consent"/><label htmlFor="application-consent">Даю <a href="/data-consent" target="_blank" rel="noreferrer">согласие на обработку данных для служебных писем</a>.</label></div><p><a href="/privacy" target="_blank" rel="noreferrer">Политика обработки персональных данных</a></p><button className={styles.primary} disabled={busy||!tariffs.length||applicationMail.seconds>0}>{applicationMail.label??'Отправить письмо'}</button>
  </form>
 </AccessCard>}</>:
 <main className={styles.landing}><div><div className={styles.entryIcon}><ShieldCheck size={24}/></div><p className={styles.eyebrow}>Финансовый анализатор</p><h1>Понимайте, куда уходят деньги</h1><p>Соберите операции из банков в одном месте. Следите за бюджетами и задавайте вопросы о своих финансах Анализатору.</p><div className={styles.actions}><a className={styles.primary} href="#access">Получить доступ <ArrowRight size={17}/></a><a className={styles.secondary} href="/price">Посмотреть тарифы</a></div></div>
 <aside className={styles.landingPreview} aria-label="Пример отчёта">
  <div className={styles.landingPreviewHead}><strong>Расходы за месяц</strong><span>Пример отчёта</span></div><strong className={styles.previewTotal}>42 680 ₽</strong>
  <div className={styles.previewBars} aria-hidden="true">{[31,57,42,78,51,91,69].map((v,i)=><i key={i} style={{height:v+'%'}}/>)}</div>
  <dl className={styles.previewBreakdown}><div><dt>Продукты</dt><dd>18 400 ₽</dd></div><div><dt>Транспорт</dt><dd>7 250 ₽</dd></div><div><dt>Остальные расходы</dt><dd>17 030 ₽</dd></div></dl>
 </aside></main>}
 <LegalFooter/></div>;
}
