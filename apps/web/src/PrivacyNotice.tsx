import {useState} from 'react';
import {OperationDialog} from './OperationDialog';
import common from './App.module.css';
import styles from './ServerAccess.module.css';

export function PrivacyFacts(){
 return <div className={styles.privacyFacts}>
  <section><h3>Выписки и операции</h3><p>Файл выписки и пароль к нему обрабатываются на устройстве. На сервер отправляются подготовленные записи: даты, суммы и очищенные описания. Банковские идентификаторы, нужные для сопоставления выписок, заменяются кодами.</p></section>
  <section><h3>Защита аккаунта</h3><p>Сайт передаёт данные по HTTPS. Пароль хранится в виде стойкого хеша. Ключи сопоставления выписок и содержимое очереди писем шифруются.</p></section>
  <section><h3>ИИ и финансовые расчёты</h3><p>Итоги рассчитывает CashNeuro. Когда для запроса или определения категории нужна модель, она получает подготовленный контекст. Исходные выписки, пароли и номера карт ей не передаются.</p></section>
  <section><h3>Cookie и настройки устройства</h3><p>Технические cookie нужны для входа и подтверждения заявки. Оформление и настройки запуска хранятся в браузере. Рекламные и аналитические cookie CashNeuro не устанавливает.</p></section>
 </div>;
}
const noticeKey='cashneuro-cookie-notice-v1';
export function CookieNotice(){
 const [open,setOpen]=useState(()=>{try{return !localStorage.getItem(noticeKey);}catch{return true;}}),[details,setDetails]=useState(false);
 const close=()=>{try{localStorage.setItem(noticeKey,'read');}catch{/* Optional acknowledgment. */}setOpen(false);};
 if(!open)return null;
 return <><aside className={styles.cookieNotice} aria-label="Использование cookie"><p>Технические cookie нужны для входа и работы аккаунта.</p><button className={common.linkButton} onClick={()=>setDetails(true)}>Подробнее</button><button className={common.button} onClick={close}>Понятно</button></aside>
 {details&&<OperationDialog title="Конфиденциальность" compact onClose={()=>setDetails(false)} footer={<button className={common.button} onClick={()=>setDetails(false)}>Закрыть</button>}><PrivacyFacts/></OperationDialog>}</>;
}
const seller=import.meta.env.VITE_PUBLIC_SELLER_NAME?.trim()||'Битнер Никита Андреевич',taxId=import.meta.env.VITE_PUBLIC_SELLER_INN?.trim()||'421408478543',support=import.meta.env.VITE_PUBLIC_SUPPORT_EMAIL?.trim();
export function SellerDetails(){
 return <>{seller&&taxId&&/^\d{12}$/.test(taxId)&&<span>Исполнитель: {seller} · ИНН {taxId}</span>}{support&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support)&&<a href={'mailto:'+support}>Поддержка</a>}</>;
}
