import common from './App.module.css';

export function focusCommonPeriod(){
 document.querySelector<HTMLInputElement>('[data-common-period-start]')?.focus();
}

export function FilteredEmpty({onPeriod=focusCommonPeriod}:{onPeriod?:()=>void}){
 return <div className={common.filteredEmpty}><p role="status">Нет операций по выбранным фильтрам</p><button type="button" className={common.button} onClick={onPeriod}>Изменить период</button></div>;
}
