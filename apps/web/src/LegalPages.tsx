import {useEffect,useState} from 'react';
import {Brand} from './Brand';
import {Mail} from 'lucide-react';
import {supportEmail as support} from './SupportDialog';
import {api,apiOrigin} from './server-client';
import {legalDocuments,legalNotice} from '../../../packages/access/src/legal';
import {moneyLabel} from '../../../packages/access/src/model';
import type {Tariff} from '../../../packages/access/src/model';
import styles from './LegalPages.module.css';
import form from './ServerAccess.module.css';

type LegalKind=keyof typeof legalDocuments;
const texts=import.meta.glob('../../../docs/legal/*.md',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const groups=[
 ['Сервис',[['Тарифы','/price'],['Оплата и возврат','/payments'],['Контакты','/contacts']]],
 ['Документы',[['Условия использования','/terms'],['Публичная оферта','/offer'],['Конфиденциальность','/privacy']]],
] as const;
const address=String(import.meta.env.VITE_PUBLIC_SELLER_ADDRESS??'').trim();
const phone=String(import.meta.env.VITE_PUBLIC_SUPPORT_PHONE??'').trim();
const ready=import.meta.env.VITE_PUBLIC_LEGAL_PUBLISHED==='1';
export function LegalFooter(){
 return <footer className={styles.footer}><div className={styles.footerTop}><a href="/" aria-label="CashNeuro — на главную"><Brand/></a><nav aria-label="Информация о CashNeuro">{groups.map(([group,links])=><div className={styles.footerGroup} key={group}><strong>{group}</strong><div>{links.map(([label,path])=><a key={path} href={path}>{label}</a>)}</div></div>)}</nav></div><div className={styles.requisites}>Исполнитель: Битнер Никита Андреевич · ИНН 421408478543</div></footer>;
}
export function usePublicTariffs(enabled=true){
 const [tariffs,setTariffs]=useState<Tariff[]|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{if(!enabled||!apiOrigin)return;let active=true;
  const reload=()=>void api<{tariffs:Tariff[]}>('/access/tariffs',undefined,AbortSignal.timeout(10000)).then(r=>{if(active){setTariffs(r.tariffs);setFailed(false);}}).catch(()=>{if(active)setFailed(true);});
  reload();window.addEventListener('focus',reload);const timer=window.setInterval(()=>{if(document.visibilityState==='visible')reload();},60000);
  return()=>{active=false;window.removeEventListener('focus',reload);window.clearInterval(timer);};
 },[enabled]);
 return {tariffs,failed};
}
export function TariffCards({tariffs,showLink=false}:{tariffs:Tariff[];showLink?:boolean}){
 return <div className={styles.tariffs}>{tariffs.map(t=><article key={t.id}><h3>{t.name}</h3><p className={styles.price}>{moneyLabel(t.priceMinor)}</p><p>{t.aiQuota.toLocaleString('ru-RU')} единиц Анализатора {t.duration.kind==='days'?'за период':'в месяц'}</p>{showLink&&<a className={styles.tariffAction} href={'/#access?tariff='+encodeURIComponent(t.id)}>Выбрать тариф</a>}</article>)}</div>;
}
export function isLegalPath(path:string){return ['/price','/tariffs','/contacts',...Object.values(legalDocuments).map(d=>d.path as string)].includes(path.replace(/\/$/,''));}
function LegalText({body}:{body:string}){
 return <>{body.trim().split(/\n\s*\n/).map((section,i)=>{const lines=section.split('\n'),first=lines[0]??'';
  if(first.startsWith('## '))return <section key={i}><h2>{first.slice(3)}</h2>{lines.slice(1).length>0&&<p>{lines.slice(1).join(' ')}</p>}</section>;
  if(lines.every(l=>l.startsWith('- ')))return <ul key={i}>{lines.map((l,n)=><li key={n}>{l.slice(2)}</li>)}</ul>;
  return <p key={i}>{lines.join(' ')}</p>;
 })}</>;
}
export function LegalPage({path}:{path:string}){
 const normalized=path.replace(/\/$/,''),entry=(Object.entries(legalDocuments) as [LegalKind,(typeof legalDocuments)[LegalKind]][]).find(([,d])=>d.path===normalized);
 const legacy=normalized==='/tariffs';
 useEffect(()=>{if(legacy)location.replace('/price'+location.search+location.hash);},[legacy]);
 const {tariffs,failed}=usePublicTariffs(normalized==='/price'),title=entry?.[1].title??(normalized==='/contacts'?'Контакты и реквизиты':'Тарифы');
 useEffect(()=>{document.title=title+' — CashNeuro';},[title]);
 return <div className={styles.page}><header className={styles.header}><a href="/" aria-label="CashNeuro — на главную"><Brand/></a></header>
 <main className={styles.main}><h1>{title}</h1>
 {entry?<><p className={styles.meta}>Редакция {entry[1].version}{!ready&&' · Версия для ознакомления'}</p><LegalText body={texts['../../../docs/legal/'+entry[0]+'.md']??''}/>{entry[0]!=='terms'&&<nav className={styles.documentLinks} aria-label="Связанные документы">{(entry[0]==='offer'||entry[0]==='payments')&&<a href="/autorenewal">Условия автопродления</a>}{entry[0]==='privacy'&&<a href="/data-consent">Открыть текст согласия</a>}<a href="/contacts">Контакты и реквизиты</a></nav>}</>:normalized==='/contacts'?<>
 <dl className={styles.details}><div><dt>Исполнитель и оператор</dt><dd>Битнер Никита Андреевич</dd></div><div><dt>ИНН</dt><dd>421408478543</dd></div><div><dt>Налоговый режим</dt><dd>Налог на профессиональный доход</dd></div>{support&&<div><dt>Поддержка, претензии и запросы о данных</dt><dd><a className={styles.emailLink} href={'mailto:'+support}><Mail size={16} aria-hidden="true"/>{support}</a></dd></div>}{phone&&<div><dt>Телефон</dt><dd>{phone}</dd></div>}{address&&<div><dt>Почтовый адрес</dt><dd>{address}</dd></div>}</dl>{!support&&<p className={styles.meta}>Контакты поддержки будут опубликованы перед запуском оплаты.</p>}</>:<>
 {failed?<p role="alert">Не удалось загрузить тарифы.</p>:tariffs?.length?<TariffCards tariffs={tariffs} showLink/>:tariffs||!apiOrigin?<p>Тарифы пока недоступны.</p>:<p role="status">Загружаем тарифы…</p>}
</>}</main><LegalFooter/></div>;
}
type LegalStatus={termsAccepted:boolean;privacySeen:boolean;billingChanged?:boolean};
export function LegalUpdate({signedIn}:{signedIn:boolean}){
 const [status,setStatus]=useState<LegalStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{if(!ready||!signedIn)return;let live=true;const load=()=>void api<LegalStatus>('/access/legal').then(v=>{if(live)setStatus(v);}).catch(()=>{});load();window.addEventListener('focus',load);return()=>{live=false;window.removeEventListener('focus',load);};},[signedIn]);
 if(!ready||!signedIn||!status||status.termsAccepted&&status.privacySeen&&!status.billingChanged)return null;
 async function record(document:'terms'|'privacy_notice'){setBusy(true);setError('');try{setStatus(await api('/access/legal-accept',{document,version:legalDocuments[document==='terms'?'terms':'privacy'].version}));}catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить подтверждение.');}finally{setBusy(false);}}
 return <aside className={styles.notice} aria-label="Обновление документов">{(!status.termsAccepted||!status.privacySeen)&&<><strong>Документы CashNeuro обновились</strong><p>{legalNotice}</p></>}
 {status.billingChanged&&<p>Условия автопродления изменились. Без вашего подтверждения списаний не будет. <a href="/#account">Проверить в аккаунте</a></p>}<div>{!status.termsAccepted&&<><a href="/terms" target="_blank" rel="noreferrer">Прочитать условия</a><button type="button" className={form.secondary} disabled={busy} onClick={()=>void record('terms')}>Принять условия</button></>}{!status.privacySeen&&<><a href="/privacy" target="_blank" rel="noreferrer">Прочитать политику</a><button type="button" className={form.secondary} disabled={busy} onClick={()=>void record('privacy_notice')}>Скрыть уведомление о политике</button></>}</div>{error&&<p className={form.error} role="alert">{error}</p>}</aside>;
}
