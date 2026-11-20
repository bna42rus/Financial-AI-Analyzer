import {useState} from 'react';
import type {InterfaceAction} from '../../../packages/analyzer/src/interface-actions';
import type {Appearance} from './Settings';
import type {NavigationPreferences} from './navigation-preferences';
import common from './App.module.css';
export type AnalyzerDeviceControls={appearance:Appearance;preferences:NavigationPreferences;onAppearance:(value:Appearance)=>void;onPreferences:(value:NavigationPreferences)=>void;navigate:(hash:string)=>void;importFiles:()=>void};
export function AnalyzerDeviceAction({action,device,disabled,onApplied,onClose}:{action:InterfaceAction;device:AnalyzerDeviceControls;disabled:boolean;onApplied:()=>void;onClose:()=>void}){
 const [applied,setApplied]=useState(false),[previous,setPrevious]=useState<Record<string,unknown>|null>(null);
 const current=action.kind==='appearance'?device.appearance:device.preferences,patch=action.kind==='appearance'||action.kind==='navigation_preference'?action.patch:null;
 const canUndo=patch&&Object.entries(patch).every(([k,v])=>(current as unknown as Record<string,unknown>)[k]===v);
 function apply(){
  if(disabled)return;
  if(action.kind==='navigate'){onApplied();onClose();device.navigate(action.hash);return;}
  if(action.kind==='import'){onApplied();onClose();device.importFiles();return;}
  setPrevious(Object.fromEntries(Object.keys(action.patch).map(k=>[k,(current as unknown as Record<string,unknown>)[k]])));
  if(action.kind==='appearance')device.onAppearance({...device.appearance,...action.patch});else device.onPreferences({...device.preferences,...action.patch});
  setApplied(true);onApplied();
 }
 function undo(){if(!previous||!canUndo||disabled)return;if(action.kind==='appearance')device.onAppearance({...device.appearance,...previous});else device.onPreferences({...device.preferences,...previous});onClose();}
 return <section className={common.panel} aria-label="Настройка из Анализатора"><h3>{action.title}</h3><p>{applied?'Настройка применена на этом устройстве.':action.kind==='appearance'?'Изменится только оформление на этом устройстве.':action.kind==='navigation_preference'?'Изменится настройка следующего открытия сайта.':action.kind==='import'?'Откроется выбор выписки. Перед загрузкой вы увидите подготовленные данные.':'Откроется указанный раздел вашего рабочего пространства.'}</p>
  {applied?<><p role="status">Финансовые данные сохранены.</p><button className={common.button} disabled={disabled||!canUndo} onClick={undo}>Отменить настройку</button>{!canUndo&&<p>Настройка уже изменилась. Отмена не перезапишет новое значение.</p>}</>:<button className={common.primaryButton} disabled={disabled} onClick={apply}>{action.kind==='navigate'?'Открыть раздел':action.kind==='import'?'Выбрать выписку':'Применить настройку'}</button>}
  <button type="button" className={common.button} disabled={disabled} onClick={onClose}>{applied?'Закрыть результат настройки':'Не применять настройку'}</button>
 </section>;
}
