import {useEffect,useMemo,useState} from 'react';
import {SearchFilter} from './SearchFilter';
import {OperationField} from './OperationDialog';
import {defaultAppearance} from './Settings';
import type {Appearance} from './Settings';
import {defaultNavigationPreferences} from './navigation-preferences';
import type {NavigationPreferences} from './navigation-preferences';
import common from './App.module.css';
import styles from './Settings.module.css';

const deviceZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'Etc/UTC';
const zoneModeKey='cashneuro-timezone-device';
export function followsDeviceTimezone(){try{return localStorage.getItem(zoneModeKey)==='yes';}catch{return false;}}
const cities:Record<string,string>={'Europe/Moscow':'Москва','Europe/Kaliningrad':'Калининград','Europe/Samara':'Самара','Asia/Yekaterinburg':'Екатеринбург','Asia/Omsk':'Омск','Asia/Novosibirsk':'Новосибирск','Asia/Krasnoyarsk':'Красноярск','Asia/Irkutsk':'Иркутск','Asia/Yakutsk':'Якутск','Asia/Vladivostok':'Владивосток','Asia/Magadan':'Магадан','Asia/Kamchatka':'Петропавловск-Камчатский','Etc/UTC':'Всемирное время'};
export const timezoneLabel=(id:string)=>{const zone=new Intl.DateTimeFormat('ru',{timeZone:id,timeZoneName:'longOffset'}).formatToParts().find(p=>p.type==='timeZoneName')?.value.replace('GMT','UTC')??'';return (cities[id]??id.replaceAll('_',' '))+' · '+zone;};
export function TimezonePicker({value,onChange,disabled}:{value:string;onChange:(v:string)=>void;disabled:boolean}){
 const zones=useMemo(()=>[...new Set([...Object.keys(cities),deviceZone(),...(Intl.supportedValuesOf?.('timeZone')??[])])].map(id=>[id,timezoneLabel(id)] as const),[]);
 return <SearchFilter label="Часовой пояс" single options={[['device','Как на устройстве'],...zones,...(value!=='device'&&!zones.some(([id])=>id===value)?[[value,timezoneLabel(value)] as const]:[])]} value={[value]} onChange={ids=>onChange(ids.find(id=>id!==value)??value)} disabled={disabled}/>;
}
export function InterfaceSettings({appearance,preferences,disabled,onAppearance,onPreferences}:{appearance:Appearance;preferences:NavigationPreferences;disabled:boolean;onAppearance:(v:Appearance)=>void;onPreferences:(v:NavigationPreferences)=>void}){
 const [look,setLook]=useState(appearance),[nav,setNav]=useState(preferences),[saved,setSaved]=useState(false);
 useEffect(()=>{setLook(appearance);setNav(preferences);},[appearance,preferences]);
 const changed=look.theme!==appearance.theme||look.textSize!==appearance.textSize||nav.startScreen!==preferences.startScreen||nav.defaultPeriod!==preferences.defaultPeriod;
 return <form className={styles.settingsStack} onSubmit={e=>{e.preventDefault();if(!disabled&&changed){onAppearance({...look,motion:'system',density:'comfortable'});onPreferences(nav);setSaved(true);}}} onChange={()=>setSaved(false)}><div className={styles.interfaceGrid}>
  <OperationField label="Тема"><select value={look.theme} disabled={disabled} onChange={e=>setLook({...look,theme:e.target.value as Appearance['theme']})}><option value="system">Как на устройстве</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></OperationField>
  <OperationField label="Размер текста"><select value={look.textSize} disabled={disabled} onChange={e=>setLook({...look,textSize:e.target.value as Appearance['textSize']})}><option value="standard">Стандартный</option><option value="large">Крупный</option></select></OperationField>
  <OperationField label="Стартовый экран"><select value={nav.startScreen} disabled={disabled} onChange={e=>setNav({...nav,startScreen:e.target.value as NavigationPreferences['startScreen']})}><option value="overview">Обзор</option><option value="operations">Операции</option><option value="analyzer">Анализатор</option><option value="last">Последний открытый</option></select></OperationField>
  <OperationField label="Период по умолчанию"><select value={nav.defaultPeriod} disabled={disabled} onChange={e=>setNav({...nav,defaultPeriod:e.target.value as NavigationPreferences['defaultPeriod']})}><option value="current_month">Текущий месяц</option><option value="last_30_days">Последние 30 дней</option><option value="current_year">Текущий год</option><option value="all">Всё время</option></select></OperationField>
 </div><div className={styles.interfaceActions}><button type="button" className={common.linkButton} disabled={disabled} onClick={()=>{setLook(defaultAppearance);setNav(defaultNavigationPreferences);setSaved(false);}}>Восстановить настройки по умолчанию</button><button type="button" className={common.button} disabled={disabled||!changed} onClick={()=>{setLook(appearance);setNav(preferences);setSaved(false);}}>Сбросить</button><button type="submit" className={common.primaryButton} disabled={disabled||!changed}>Применить</button></div>{saved&&<p className={styles.muted} role="status">Настройки сохранены.</p>}</form>;
}
