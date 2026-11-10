import {durationLabel} from '../../../packages/access/src/model.ts';
import type {Duration} from '../../../packages/access/src/model.ts';
import {email} from './types.ts';
export type Message={to:string;subject:string;text:string;html?:string};
export type MailOrigins={financeOrigin:string;controlOrigin:string;adminRecipient:string};
function value(p:Record<string,unknown>,key:string,max=500){const v=p[key];if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('INVALID_PAYLOAD');return v;}
function origin(value:string){const u=new URL(value);if(u.origin!==value||!['http:','https:'].includes(u.protocol))throw new Error('INVALID_ORIGIN');return value;}
function at(value:unknown){const date=new Date(String(value));if(!Number.isFinite(date.getTime()))throw new Error('INVALID_PAYLOAD');return date.toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' (Москва)';}
function money(value:unknown){if(typeof value!=='string'||!/^\d{1,19}$/.test(value))throw new Error('INVALID_PAYLOAD');const n=BigInt(value);return (n/100n).toString()+','+(n%100n).toString().padStart(2,'0')+' ₽';}
export function describeDevice(userAgent:string|undefined){
 const s=(userAgent??'').slice(0,512),browser=/YaBrowser\//i.test(s)?'Яндекс Браузер':/Edg(?:A|iOS)?\//.test(s)?'Edge':/Firefox\//.test(s)?'Firefox':/Chrome\//.test(s)?'Chrome':/Safari\//.test(s)?'Safari':'Неизвестный браузер';
 const device=/iPhone|iPad/.test(s)?'iPhone / iPad':/Android/.test(s)?'Android':/Windows/.test(s)?'Windows':/Macintosh/.test(s)?'Mac':/Linux/.test(s)?'Linux':'Неизвестное устройство';
 return browser+' · '+device;
}
type MailBody={ paragraphs:string[]; action?:{label:string;href:string}; facts?:[string,string][]; code?:string; note?:string; unexpected?:string };
const support='support@cashneuro.ru';
function escapeHtml(s:string){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
function formatMail(subject:string,body:MailBody){
 const h=escapeHtml, paragraph=(s:string)=>'<p style="margin:0 0 16px;color:#253052">'+h(s)+'</p>';
 const facts=body.facts?.length?'<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;background:#f4f3fe;border-radius:10px">'+body.facts.map(([k,v])=>'<tr><td style="padding:8px 12px;color:#53617e">'+h(k)+'</td><td align="right" style="padding:8px 12px;color:#19213b"><strong>'+h(v)+'</strong></td></tr>').join('')+'</table>':'';
 const code=body.code?'<p style="margin:0 0 18px;padding:12px 14px;background:#f1efff;color:#3a2ab4;border-radius:8px;font:700 21px/1.4 monospace;overflow-wrap:anywhere">'+h(body.code)+'</p>':'';
 const action=body.action?'<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 20px"><tr><td bgcolor="#4d3dd8" style="border-radius:8px"><a href="'+h(body.action.href)+'" style="display:inline-block;border:1px solid #4d3dd8;padding:11px 17px;color:#fff;text-decoration:none;font-weight:bold;border-radius:8px">'+h(body.action.label)+'</a></td></tr></table>':'';
 const unexpected=body.unexpected?'<p style="margin:0 0 16px;padding:10px 12px;background:#fff5df;border-radius:8px;color:#65440d;font-size:14px">'+h(body.unexpected)+'</p>':'';
 const note=body.note?'<p style="margin:0;color:#53617e;font-size:13px">'+h(body.note)+'</p>':'';
 const text=[...body.paragraphs,body.unexpected,...(body.facts?.length?[body.facts.map(([k,v])=>k+': '+v).join('\n')]:[]),body.code,body.action&&body.action.label+': '+body.action.href,body.note,'Команда CashNeuro · '+support].filter(Boolean).join('\n\n');
 const html='<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f3f4fa"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f3f4fa"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;font:15px/1.55 Arial,sans-serif;color:#19213b"><tr><td style="padding:0 0 14px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td><img src="cid:cashneuro-mark" width="36" height="36" alt="" style="display:block;border:0"></td><td style="padding-left:10px;font-size:22px;font-weight:bold">Cash<span style="color:#4d3dd8">Neuro</span></td></tr></table></td></tr><tr><td bgcolor="#ffffff" style="padding:24px;border:1px solid #dce0f0;border-radius:14px"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">'+h(subject)+'</h1>'+body.paragraphs.map(paragraph).join('')+facts+unexpected+code+action+note+'</td></tr><tr><td style="padding:14px 0;color:#53617e;font-size:13px">Команда CashNeuro · <a href="mailto:'+support+'" style="color:#4d3dd8">'+support+'</a></td></tr></table></td></tr></table></body></html>';
 return {text,html};
}
export function renderMail(kind:string,p:Record<string,unknown>,options:MailOrigins,createdAt:string):Message{
 const account=email(p.email),base=origin(p.profile==='control'?options.controlOrigin:options.financeOrigin);
 const link=(route:string)=>base+'/#'+route+'?token='+encodeURIComponent(value(p,'token',100));
 const action=(label:string,href:string)=>({label,href});
 const contact=action('Написать в поддержку',origin(options.financeOrigin)+'/contacts'), signIn=action('Войти в CashNeuro',base+'/#login'), profile=action('Открыть аккаунт',base+'/#account'), access=action('Открыть заявку',base+'/#access');
 let to=account,subject:string,body:MailBody;
 switch(kind){
  case 'application_verification':
   subject='Подтвердите почту';body={paragraphs:['Подтвердите адрес, чтобы продолжить оформление доступа к CashNeuro.'],action:action('Подтвердить почту',link('verify')),note:'Ссылка действует 30 минут.',unexpected:'Если вы не подавали заявку, проигнорируйте письмо.'};break;
  case 'owner_email_verification':
   if(p.profile!=='control')throw new Error('INVALID_PAYLOAD');
   subject='Подтвердите создание администратора';body={paragraphs:['На сервере запущено создание первого администратора тестовой среды. Введите код в консоли при выполнении owner:complete.','После создания аккаунта настройте двухфакторную аутентификацию в админке.'],code:value(p,'code',100),note:'Код действует 15 минут. Никому его не передавайте.',unexpected:'Если вы не запускали создание администратора, проигнорируйте письмо.'};break;
  case 'invitation':case 'billing_invitation':
   subject='Приглашение в CashNeuro';body={paragraphs:[kind==='billing_invitation'?'Оплата подтверждена. Создайте аккаунт, чтобы начать оплаченный период.':'Для вас подготовлен доступ. Создайте аккаунт по приглашению.'],facts:[['Ссылка действует до',at(p.expiresAt)]],action:action('Создать аккаунт',link('invite')),note:'Если ссылка истечёт, обратитесь в поддержку. Повторно оплачивать доступ не нужно.',unexpected:'Если вы не оформляли доступ и не ждали приглашение, проигнорируйте письмо.'};break;
  case 'registration_verification':
   subject='Код для регистрации';body={paragraphs:['Введите этот код на странице регистрации CashNeuro.'],code:value(p,'proofToken',100),note:'Код действует 15 минут и подходит только к этому приглашению.',unexpected:'Если вы не запрашивали код регистрации, проигнорируйте письмо. Никому не сообщайте код.'};break;
  case 'analyzer_topup':
   if(![1000,2000,5000,10000].includes(Number(p.units)))throw new Error('INVALID_PAYLOAD');
   subject='Лимит Анализатора пополнен';body={paragraphs:['Пакет добавлен. Неиспользованные единицы сохраняются при переходе на следующий месяц.'],facts:[['Добавлено единиц',Number(p.units).toLocaleString('ru-RU')]],action:action('Открыть Анализатор',base+'/#analyzer')};break;
  case 'profile_email_verification':
   subject='Подтвердите новую почту';body={paragraphs:['Введите код в окне CashNeuro, где запросили смену адреса.'],code:value(p,'code',100),note:'Код действует 15 минут.',unexpected:'Если вы не запрашивали смену почты, проигнорируйте письмо. Никому не сообщайте код.'};break;
  case 'profile_email_changed':
   subject='Почта для входа изменена';body={paragraphs:['Адрес для входа в CashNeuro изменён. Другие сеансы завершены.'],action:contact,unexpected:'Если вы не меняли почту, сразу сообщите в поддержку.'};break;
  case 'account_deletion_code':
   subject='Подтвердите заявку на удаление аккаунта';body={paragraphs:['Введите код в окне подачи заявки в CashNeuro.'],code:value(p,'code',6),note:'Код действует 15 минут.',unexpected:'Если вы не запрашивали удаление, проигнорируйте письмо. Никому не сообщайте код.'};break;
  case 'account_deletion_received':
   subject='Заявка на удаление аккаунта принята';body={paragraphs:['Заявка передана администратору. Её можно отозвать на странице аккаунта до начала удаления.'],action:profile,unexpected:'Если вы не подавали заявку, отзовите её и смените пароль.'};break;
  case 'account_deletion_completed':
   subject='Аккаунт CashNeuro удалён';body={paragraphs:['Заявка выполнена. Аккаунт и данные кабинета удалены, сеансы завершены. Записи, которые требуются для соблюдения закона, хранятся отдельно.'],facts:[['Номер заявки',value(p,'requestId',36)]],action:contact};break;
  case 'password_reset':
   subject='Восстановление пароля';body={paragraphs:['Задайте новый пароль для входа в CashNeuro. После смены пароля прежние сеансы завершатся.'],action:action('Задать новый пароль',link('reset')),note:'Ссылка одноразовая и действует 15 минут.',unexpected:'Если вы не запрашивали восстановление пароля, проигнорируйте письмо.'};break;
  case 'security_password_changed':
   subject='Пароль изменён';body={paragraphs:['Пароль аккаунта изменён. Прежние сеансы завершены.'],facts:[['Когда',at(createdAt)]],action:contact,unexpected:'Если вы не меняли пароль, сразу сообщите в поддержку.'};break;
  case 'security_admin_recovery':
   subject='Начато восстановление доступа администратора';body={paragraphs:['Прежние сеансы завершены, прежний ключ двухфакторной защиты отключён. Действия в админке будут доступны после настройки нового ключа.'],facts:[['Когда',at(createdAt)]],action:contact,unexpected:'Если вы не запускали восстановление, сразу сообщите в поддержку.'};break;
  case 'security_login':
   subject='Новый вход в аккаунт';body={paragraphs:['В CashNeuro вошли с нового сеанса.'],facts:[['Когда',at(p.at??createdAt)],['Устройство',typeof p.device==='string'?p.device:'Неизвестное устройство']],action:profile,unexpected:'Если это были не вы, смените пароль и проверьте активные сеансы.'};break;
  case 'existing_account':
   subject='Ваш аккаунт уже существует';body={paragraphs:['Этот адрес указали при оформлении доступа к CashNeuro. На него уже зарегистрирован аккаунт.','Если запрос был вашим, войдите с паролем или восстановите его на странице входа.'],action:signIn,unexpected:'Если вы не оформляли доступ, проигнорируйте письмо.'};break;
  case 'existing_invitation':
   subject='Для вас уже подготовлен доступ';body={paragraphs:['На эту почту уже выдано приглашение. Откройте ранее полученное письмо. Если ссылка недоступна, запросите новую в поддержке.'],action:contact,unexpected:'Если вы не оформляли доступ, проигнорируйте письмо.'};break;
  case 'access_activated':
   subject='Доступ активирован';body={paragraphs:['Регистрация завершена. Войдите с паролем, который выбрали при регистрации.'],facts:[['Начало доступа',at(p.activatedAt)],['Доступ',p.indefinite===true?'Бессрочный':'До '+at(p.accessEnd)]],action:signIn,unexpected:'Если вы не регистрировались, сообщите в поддержку.'};break;
  case 'account_access_status':
   subject=p.blocked===true?'Доступ CashNeuro приостановлен':'Ограничение доступа CashNeuro снято';
   body={paragraphs:[p.blocked===true?'Доступ к операциям, отчётам и Анализатору приостановлен. Напишите в поддержку, чтобы уточнить причину и восстановить доступ.':'Ограничение снято. Текущий срок доступа можно проверить в аккаунте.'],action:action('Открыть CashNeuro',base+'/#account')};break;
  case 'billing_refund':
   subject='Возврат оплаты CashNeuro подтверждён';body={paragraphs:['ЮKassa подтвердила возврат на исходное средство оплаты.'],facts:[['Сумма возврата',money(p.amountMinor)],['Вид возврата',p.full===true?'Полный':'Частичный']],action:contact};break;
  case 'manual_quota_changed':
   subject='Лимит Анализатора изменён';body={paragraphs:['Настройки лимита Анализатора обновлены. Актуальный остаток и дату обновления можно проверить в аккаунте.'],action:action('Открыть CashNeuro',base+'/#analyzer')};break;
  case 'manual_access_changed':
   subject='Срок доступа изменён';body={paragraphs:[p.indefinite===true?'Доступ стал бессрочным.':'Срок доступа обновлён.'],facts:[...(p.indefinite===true?[]:[['Доступ до',at(p.accessEnd)] as [string,string]]),...(Number.isSafeInteger(p.analyzerUnits)?[['Лимит Анализатора',String(p.analyzerUnits)+' единиц'+(Number.isSafeInteger(p.periodDays)?' каждые '+String(p.periodDays)+' дн.':' в месяц')] as [string,string]]:[])],action:profile,note:'Если аккаунт заблокирован, изменение срока не снимает блокировку.'};break;
  case 'payment_decision':case 'renewal_decision':{
   const renewal=kind==='renewal_decision', status=value(p,'status',50);
   const states:Record<string,[string,string]>={
    paid_not_activated:['Оплата подтверждена','Приглашение для регистрации придёт отдельным письмом. Оплаченный период начнётся после регистрации.'],
    completed:['Доступ продлён','Оплата подтверждена. Новый срок уже доступен в аккаунте.'],
    needs_topup:['Для оплаты нужна доплата','Полученной суммы недостаточно. Откройте заявку, чтобы узнать, как доплатить.'],
    rejected:['Оплату не подтвердили','Свяжитесь с поддержкой, чтобы уточнить причину и порядок возврата, если деньги были списаны.'],
   };
   if(!Object.hasOwn(states,status))throw new Error('INVALID_PAYLOAD');
   const [heading,copy]=states[status]!;subject=heading;body={paragraphs:[copy],facts:[...(status==='needs_topup'&&p.remainingMinor?[['Осталось доплатить',money(p.remainingMinor)] as [string,string]]:[]),...(p.accessEnd?[['Доступ до',at(p.accessEnd)] as [string,string]]:[])],action:status==='rejected'?contact:renewal?profile:access,unexpected:renewal?undefined:'Если вы не оформляли доступ, сообщите в поддержку.'};break;
  }
  case 'payment_claim':case 'renewal_claim':{
   to=email(options.adminRecipient);subject=kind==='renewal_claim'?'Сверьте оплату продления':'Сверьте оплату первого доступа';
   const tariff=p.tariff as Record<string,unknown>|undefined;if(!tariff)throw new Error('INVALID_PAYLOAD');
   body={paragraphs:['Пользователь сообщил о переводе. Сверьте поступление и внесите решение в админке.'],facts:[['Заявитель',value(p,'name',100)+' · '+account],['Отправитель',value(p,'senderName',100)],['Банк',value(p,'senderBank',100)],['Ожидаемая сумма',money(p.expectedMinor)],['Тариф',value(tariff,'name',160)],...(tariff.duration&&typeof tariff.duration==='object'?[['Период',durationLabel(tariff.duration as Duration)] as [string,string]]:[]),['Заявка создана',at(p.createdAt)],['Об оплате сообщили',at(p.lastClaimedAt??p.claimedAt)]],action:action('Открыть админку',origin(options.controlOrigin)),note:'Уведомление само по себе не подтверждает оплату.'};break;
  }
  case 'billing_notice':
   subject='Предстоящее автопродление CashNeuro';body={paragraphs:['Доступ продлится автоматически, если платёж пройдёт. Если продление не нужно, отключите его в аккаунте до даты списания.'],facts:[['Дата списания',at(p.dueAt)],['Сумма',money(p.priceMinor)]],action:action('Управлять автопродлением',profile.href),note:'Если не получается отключить автопродление, напишите в поддержку.'};break;
  case 'billing_paid':
   subject='Оплата доступа подтверждена';body={paragraphs:['Срок доступа обновлён. По вопросам оплаты или чека можно написать в поддержку.'],facts:[['Оплачено',money(p.priceMinor)],['Доступ до',at(p.accessEnd)]],action:profile};break;
  case 'billing_changed':
   subject='Автопродление приостановлено';body={paragraphs:['Условия автопродления изменились. Деньги по новым условиям не спишутся без вашего подтверждения. Уже оплаченный доступ сохраняется.'],action:action('Посмотреть тарифы',base+'/tariffs')};break;
  case 'access_reminder':
   subject='Скоро закончится доступ';body={paragraphs:['Чтобы продолжить пользоваться CashNeuro после этой даты, продлите доступ в аккаунте.'],facts:[['Доступ до',at(p.accessEnd)]],action:action('Продлить доступ',profile.href)};break;
  case 'access_expired':
   subject='Срок доступа закончился';body={paragraphs:['Операции и финансовые инструменты снова будут доступны после подтверждения продления. В аккаунт можно войти уже сейчас.'],facts:[['Доступ закончился',at(p.accessEnd)]],action:action('Продлить доступ',profile.href)};break;
  default:throw new Error('INVALID_PAYLOAD');
 }
 return {to,subject,...formatMail(subject,body)};
}
export function accessWarning(end:string|null|undefined,indefinite:boolean,now=new Date()):string|null{
 if(indefinite||!end)return null;
 const e=new Date(end);if(!Number.isFinite(e.getTime()))return null;
 if(e<=now)return 'Срок доступа закончился. Продлите доступ, чтобы снова пользоваться финансовыми функциями.';
 const date=(v:Date)=>new Date(v.getTime()+10800000).toISOString().slice(0,10);
 const days=(Date.parse(date(e))-Date.parse(date(now)))/86400000;
 return days===0?'Доступ заканчивается сегодня. Продлите его заранее.':[1,3,7].includes(days)?'До окончания доступа '+days+' дн. Продлите его заранее.':null;
}
