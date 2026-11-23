import {Component,useEffect,useState} from 'react';
import type {ReactNode,ErrorInfo} from 'react';
import {Brand} from './Brand';
import {SupportLink} from './SupportDialog';
import styles from './StatusPage.module.css';
type Kind='404'|'500'|'503'|'offline';
const content:Record<Kind,[string,string]>={
 '404':['Страница не найдена','Проверьте адрес или вернитесь на главную.'],
 '500':['Не удалось открыть страницу','Попробуйте обновить страницу. Если ошибка повторится, напишите в поддержку.'],
 '503':['Сервис временно недоступен','Не удалось загрузить CashNeuro. Подождите немного и попробуйте снова.'],
 offline:['Нет соединения с интернетом','Проверьте подключение и попробуйте снова.'],
};
export function StatusPage({kind}:{kind:Kind}){const [title,description]=content[kind];return <div className={styles.page}><header><a href="/" aria-label="CashNeuro"><Brand/></a></header><main><small>{kind==='offline'?'CashNeuro':'Ошибка '+kind}</small><h1>{title}</h1><p>{description}</p><div>{kind!=='404'&&<button onClick={()=>location.reload()}>Повторить</button>}<a href="/">На главную</a><SupportLink>Поддержка</SupportLink></div></main></div>;}
class RenderBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(_error:Error,_info:ErrorInfo){/* Do not expose component stacks or account data. */}
 render(){return this.state.failed?<StatusPage kind="500"/>:this.props.children;}
}
export function AppBoundary({children}:{children:ReactNode}){
 const [offline,setOffline]=useState(!navigator.onLine),[loadFailed,setLoadFailed]=useState(false);
 useEffect(()=>{const off=()=>setOffline(true),on=()=>setOffline(false),chunk=(e:Event)=>{e.preventDefault();setLoadFailed(true);};window.addEventListener('offline',off);window.addEventListener('online',on);window.addEventListener('vite:preloadError',chunk);return()=>{window.removeEventListener('offline',off);window.removeEventListener('online',on);window.removeEventListener('vite:preloadError',chunk);};},[]);
 return offline?<StatusPage kind="offline"/>:loadFailed?<StatusPage kind="503"/>:<RenderBoundary>{children}</RenderBoundary>;
}
