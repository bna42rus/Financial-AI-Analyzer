import {Search,X} from 'lucide-react';
import type {InputHTMLAttributes} from 'react';
import {SelectField} from './SelectField';
import {CategoryFilter} from './CategoryFilter';
import styles from './Settings.module.css';

export const foldSearch=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim();
export function SearchField({value,onValueChange,...props}:Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'type'>&{value:string;onValueChange:(v:string)=>void}){
 return <div className={styles.searchField} data-search-field><Search size={17} aria-hidden="true"/><input {...props} type="search" value={value} onChange={e=>onValueChange(e.target.value)}/>{value&&<button type="button" disabled={props.disabled} aria-label="Очистить поиск" onClick={()=>onValueChange('')}><X size={16}/></button>}</div>;
}
export function SearchFilter({label,options,value,onChange,disabled,single,fullWidth,...accessibility}:{label:string;options:readonly (readonly [string,string])[];value:string[];onChange:(ids:string[])=>void;disabled:boolean;single?:boolean;fullWidth?:boolean;'aria-label'?:string;'aria-invalid'?:boolean;'aria-describedby'?:string}){
 return <CategoryFilter categories={options.map(([id,name])=>({id,name,parentId:null,role:'both',hidden:false}))} value={value} onChange={onChange} disabled={disabled} emptyLabel={label} flatLabel={label} single={single} fullWidth={fullWidth} {...accessibility}/>;
}

type SingleOptions=readonly (readonly [string,string])[];
export function FormSelect({label,options,value,onValueChange,disabled,...accessibility}:{label:string;options:SingleOptions;value:string;onValueChange:(value:string)=>void;disabled?:boolean;'aria-label'?:string;'aria-invalid'?:boolean;'aria-describedby'?:string}){
 return <SelectField aria-label={label} {...accessibility} disabled={disabled} value={value} onChange={event=>onValueChange(event.target.value)}>
  {options.map(([id,name])=><option key={id} value={id}>{name}</option>)}
 </SelectField>;
}
