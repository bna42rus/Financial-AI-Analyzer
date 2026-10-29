import type {NavigationPreferences as Preferences} from './navigation-preferences';
import {defaultNavigationPreferences} from './navigation-preferences';
import common from './App.module.css';
import styles from './Settings.module.css';
export function NavigationPreferences({value,onChange,disabled}:{value:Preferences;onChange:(value:Preferences)=>void;disabled:boolean}){
 return <section aria-label="Стартовые настройки интерфейса"><h3>При открытии</h3><div className={styles.appearance}>
  <label>Стартовый экран<select aria-label="Стартовый экран" disabled={disabled} value={value.startScreen} onChange={e=>onChange({...value,startScreen:e.target.value as Preferences['startScreen']})}><option value="overview">Обзор</option><option value="operations">Операции</option><option value="analyzer">Анализатор</option><option value="last">Последний открытый</option></select><small>Применяется при открытии сайта без ссылки на конкретный раздел. Логотип всегда ведёт на Обзор.</small></label>
  <label>Начальный период<select aria-label="Начальный период" disabled={disabled} value={value.defaultPeriod} onChange={e=>onChange({...value,defaultPeriod:e.target.value as Preferences['defaultPeriod']})}><option value="all">За всю историю</option><option value="current_month">Текущий месяц по сегодня</option><option value="last_30_days">Последние 30 дней</option><option value="current_year">Текущий год по сегодня</option></select><small>Для следующего открытия. Собственный период представления и ручной выбор имеют приоритет. Даты определяются в вашем часовом поясе.</small></label>
 </div><button type="button" className={common.button} disabled={disabled} onClick={()=>onChange({...defaultNavigationPreferences})}>Сбросить стартовые настройки</button></section>;
}
