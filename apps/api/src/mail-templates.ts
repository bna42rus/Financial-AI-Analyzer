import {email} from './types.ts';
export type Message={to:string;subject:string;text:string};
export type MailOrigins={financeOrigin:string;controlOrigin:string;adminRecipient:string};
function value(p:Record<string,unknown>,key:string,max=500){const v=p[key];if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('INVALID_PAYLOAD');return v;}
function origin(value:string){const u=new URL(value);if(u.origin!==value||!['http:','https:'].includes(u.protocol))throw new Error('INVALID_ORIGIN');return value;}
function at(value:unknown){const date=new Date(String(value));if(!Number.isFinite(date.getTime()))throw new Error('INVALID_PAYLOAD');return date.toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' (Москва)';}
function money(value:unknown){if(typeof value!=='string'||!/^\d{1,19}$/.test(value))throw new Error('INVALID_PAYLOAD');const n=BigInt(value);return (n/100n).toString()+','+(n%100n).toString().padStart(2,'0')+' ₽';}
export function describeDevice(userAgent:string|undefined){
 const s=(userAgent??'').slice(0,512),browser=/Edg\//.test(s)?'Edge':/Firefox\//.test(s)?'Firefox':/Chrome\//.test(s)?'Chrome':/Safari\//.test(s)?'Safari':'Неизвестный браузер';
 const device=/iPhone|iPad/.test(s)?'iPhone / iPad':/Android/.test(s)?'Android':/Windows/.test(s)?'Windows':/Macintosh/.test(s)?'Mac':/Linux/.test(s)?'Linux':'Неизвестное устройство';
 return browser+' · '+device;
}
export function renderMail(kind:string,p:Record<string,unknown>,options:MailOrigins,createdAt:string):Message{
 const account=email(p.email),base=origin(p.profile==='control'?options.controlOrigin:options.financeOrigin);
 const link=(route:string)=>base+'/#'+route+'?token='+encodeURIComponent(value(p,'token',100));
 let to=account,subject:string,text:string;
 switch(kind){
  case 'application_verification':subject='Подтвердите почту';text='Для продолжения заявки откройте ссылку:\n'+link('verify')+'\nСсылка действует 30 минут. Если вы не подавали заявку, проигнорируйте письмо.';break;
  case 'owner_email_verification':if(p.profile!=='control')throw new Error('INVALID_PAYLOAD');subject='Подтвердите создание первого администратора Staging';text='На сервере запущено создание первого администратора тестовой среды CashNeuro.\nВведите этот код только в консоли сервера при выполнении owner:complete:\n'+value(p,'code',100)+'\nКод действует 15 минут. Пароль вы выбираете самостоятельно. После создания аккаунта обязательно настройте TOTP в тестовой админке. Если вы не запускали настройку, проигнорируйте письмо и никому не передавайте код.';break;
  case 'invitation':subject='Приглашение в Финансовый анализатор';text='Зарегистрируйтесь по ссылке:\n'+link('invite')+'\nСрок ссылки: '+at(p.expiresAt)+'. Пароль вы выбираете самостоятельно. При регистрации потребуется отдельное подтверждение этой почты.';break;
  case 'registration_verification':subject='Подтверждение почты для регистрации';text='Введите этот код на странице регистрации:\n'+value(p,'proofToken',100)+'\nКод действует 15 минут и подходит только к текущему приглашению. Не передавайте его другим людям.';break;
  case 'password_reset':subject='Восстановление пароля';text='Задайте новый пароль:\n'+link('reset')+'\nСсылка одноразовая и действует 15 минут. После смены пароля все старые сессии завершатся. Если вы не запрашивали восстановление, проигнорируйте письмо.';break;
  case 'security_password_changed':subject='Пароль изменён';text='Пароль аккаунта изменён '+at(createdAt)+'. Старые сессии завершены. Если это сделали не вы, обратитесь в поддержку.';break;
  case 'security_admin_recovery':subject='Начато восстановление доступа администратора';text='Резервное восстановление начато '+at(createdAt)+'. Прежние сессии и TOTP отключены. Административные действия доступны только после настройки нового TOTP. Если это сделали не вы, обратитесь в поддержку.';break;
  case 'security_login':subject='Новый вход в аккаунт';text='Вход выполнен '+at(p.at??createdAt)+'.\nУстройство: '+(typeof p.device==='string'?p.device:'Неизвестное устройство')+'. Если это сделали не вы, смените пароль и завершите другие сессии.';break;
  case 'existing_account':subject='Ваш аккаунт уже существует';text='Для этой почты уже есть аккаунт. Войдите на '+base+'/#login или воспользуйтесь восстановлением пароля.';break;
  case 'existing_invitation':subject='Для вас уже подготовлен доступ';text='На эту почту уже выдано приглашение. Используйте ранее полученное письмо или обратитесь в поддержку для новой ссылки.';break;
  case 'access_activated':subject='Доступ активирован';text='Регистрация завершена '+at(p.activatedAt)+'. '+(p.indefinite===true?'Доступ бессрочный.':'Доступ до '+at(p.accessEnd)+'.')+'\nВойдите с выбранным паролем: '+base;break;
  case 'manual_access_changed':subject='Срок доступа изменён';text=p.indefinite===true?'Теперь доступ бессрочный.':'Новая дата окончания доступа: '+at(p.accessEnd)+'.';text+='\nАдминистративная блокировка, если она есть, сохраняется. Проверьте актуальное состояние в аккаунте.';break;
  case 'payment_decision':case 'renewal_decision':{
   const states:Record<string,string>={paid_not_activated:'Оплата подтверждена. Приглашение придёт отдельным письмом.',completed:'Оплата подтверждена, доступ продлён.',needs_topup:'Для подтверждения нужна доплата: '+(p.remainingMinor?money(p.remainingMinor):'уточните в поддержке')+'.',rejected:'Оплата отклонена. Свяжитесь с поддержкой для уточнения и ручного возврата, если он необходим.'};
   const status=value(p,'status',50);if(!states[status])throw new Error('INVALID_PAYLOAD');subject='Решение по оплате';text=states[status]!+(p.accessEnd?'\nДоступ до '+at(p.accessEnd)+'.':'')+'\nПроверьте актуальную заявку на сайте.';break;
  }
  case 'payment_claim':case 'renewal_claim':{
   to=email(options.adminRecipient);subject=kind==='renewal_claim'?'Продление: нужна сверка оплаты':'Новый доступ: нужна сверка оплаты';
   const tariff=p.tariff as Record<string,unknown>|undefined;if(!tariff||typeof tariff.name!=='string')throw new Error('INVALID_PAYLOAD');
   text='Пользователь: '+value(p,'name',100)+' · '+account+'\nОтправитель: '+value(p,'senderName',100)+'\nБанк: '+value(p,'senderBank',100)+'\nОжидаемая сумма: '+money(p.expectedMinor)+'\nТариф: '+tariff.name+'\nУсловия тарифа: '+JSON.stringify(tariff)+'\nЗаявка создана: '+at(p.createdAt)+'\nОтметка оплаты: '+at(p.lastClaimedAt??p.claimedAt)+'\nСверьте перевод в админке: '+origin(options.controlOrigin)+'\nЭто уведомление само не подтверждает оплату.';break;
  }
  case 'access_reminder':subject='Скоро закончится доступ';text='Доступ заканчивается '+at(p.accessEnd)+'. До окончания: '+value(p,'stage',10)+' дн.\nПродлите доступ в аккаунте: '+base;break;
  case 'access_expired':subject='Срок доступа закончился';text='Доступ закончился '+at(p.accessEnd)+'. Для восстановления откройте «Продлить доступ» в аккаунте: '+base+'\nОтметка «Я оплатил» не открывает доступ до подтверждения.';break;
  default:throw new Error('INVALID_PAYLOAD');
 }
 return {to,subject,text};
}
export function accessWarning(end:string|null|undefined,indefinite:boolean,now=new Date()):string|null{
 if(indefinite||!end)return null;
 const e=new Date(end);if(!Number.isFinite(e.getTime()))return null;
 if(e<=now)return 'Срок доступа закончился. Продлите доступ, чтобы снова пользоваться финансовыми функциями.';
 const date=(v:Date)=>new Date(v.getTime()+10800000).toISOString().slice(0,10);
 const days=(Date.parse(date(e))-Date.parse(date(now)))/86400000;
 return days===0?'Доступ заканчивается сегодня. Продлите его заранее.':[1,3,7].includes(days)?'До окончания доступа '+days+' дн. Продлите его заранее.':null;
}
