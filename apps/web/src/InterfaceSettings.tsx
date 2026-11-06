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
const label=(id:string)=>{const zone=new Intl.DateTimeFormat('ru',{timeZone:id,timeZoneName:'longOffset'}).formatToParts().find(p=>p.type==='timeZoneName')?.value.replace('GMT','UTC')??'';return (cities[id]??id.replaceAll('_',' '))+' · '+zone;};
export function TimezonePicker({value,onChange,disabled}:{value:string;onChange:(v:string)=>void;disabled:boolean}){
 const zones=useMemo(()=>[...new Set([...Object.keys(cities),deviceZone(),...(Intl.supportedValuesOf?.('timeZone')??[])])].map(id=>[id,label(id)] as const),[]);
 return <SearchFilter label="Часовой пояс" single options={[['device','Как на устройстве'],...zones,...(value!=='device'&&!zones.some(([id])=>id===value)?[[value,label(value)] as const]:[])]} value={[value]} onChange={ids=>onChange(ids.find(id=>id!==value)??value)} disabled={disabled}/>;
}
export function InterfaceSettings({appearance,preferences,timezone,disabled,onAppearance,onPreferences,onTimezone}:{appearance:Appearance;preferences:NavigationPreferences;timezone:string;disabled:boolean;onAppearance:(v:Appearance)=>void;onPreferences:(v:NavigationPreferences)=>void;onTimezone:(v:string)=>Promise<void>}){
 const [look,setLook]=useState(appearance),[nav,setNav]=useState(preferences),[zone,setZone]=useState(()=>followsDeviceTimezone()?'device':timezone),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const reset=()=>{setLook(appearance);setNav(preferences);setZone(followsDeviceTimezone()?'device':timezone);setError('');setSaved(false);};
 useEffect(()=>{setLook(appearance);setNav(preferences);setZone(followsDeviceTimezone()?'device':timezone);setError('');},[appearance,preferences,timezone]);
 const changed=look.theme!==appearance.theme||look.textSize!==appearance.textSize||look.motion!=='system'||look.density!=='comfortable'||nav.startScreen!==preferences.startScreen||nav.defaultPeriod!==preferences.defaultPeriod||zone!==(followsDeviceTimezone()?'device':timezone);
 async function apply(){if(disabled||busy)return;setBusy(true);setError('');try{const actual=zone==='device'?deviceZone():zone;if(actual!==timezone)await onTimezone(actual);try{if(zone==='device')localStorage.setItem(zoneModeKey,'yes');else localStorage.removeItem(zoneModeKey);}catch{/* Preferences remain usable without local storage. */}onAppearance({...look,motion:'system',density:'comfortable'});onPreferences(nav);setSaved(true);}catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить часовой пояс.');}finally{setBusy(false);}}
 return <form className={styles.settingsBox} onSubmit={e=>{e.preventDefault();void apply();}} onChange={()=>setSaved(false)}><div className={styles.interfaceGrid}>
  <OperationField label="Тема"><select value={look.theme} onChange={e=>setLook({...look,theme:e.target.value as Appearance['theme']})}><option value="system">Как на устройстве</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></OperationField>
  <OperationField label="Размер текста"><select value={look.textSize} onChange={e=>setLook({...look,textSize:e.target.value as Appearance['textSize']})}><option value="standard">Стандартный</option><option value="large">Крупный</option></select></OperationField>
  <OperationField label="Стартовый экран"><select value={nav.startScreen} onChange={e=>setNav({...nav,startScreen:e.target.value as NavigationPreferences['startScreen']})}><option value="overview">Обзор</option><option value="operations">Операции</option><option value="analyzer">Анализатор</option><option value="last">Последний открытый</option></select></OperationField>
  <OperationField label="Период по умолчанию"><select value={nav.defaultPeriod} onChange={e=>setNav({...nav,defaultPeriod:e.target.value as NavigationPreferences['defaultPeriod']})}><option value="all">Всё время</option><option value="current_month">Текущий месяц</option><option value="last_30_days">Последние 30 дней</option><option value="current_year">Текущий год</option></select></OperationField>
  <OperationField label="Часовой пояс" error={error}><TimezonePicker value={zone} disabled={disabled||busy} onChange={v=>{setZone(v);setError('');setSaved(false);}}/></OperationField>
 </div><div className={styles.interfaceActions}><button type="button" className={common.linkButton} disabled={disabled||busy} onClick={()=>{setLook(defaultAppearance);setNav(defaultNavigationPreferences);setZone('device');setSaved(false);setError('');}}>По умолчанию</button><button type="button" className={common.button} disabled={disabled||busy||!changed} onClick={reset}>Сбросить</button><button type="submit" className={common.primaryButton} disabled={disabled||busy||!changed}>Применить</button></div>{saved&&<p className={styles.muted} role="status">Настройки сохранены.</p>}</form>;
}
