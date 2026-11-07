import {Search,X} from 'lucide-react';
import type {InputHTMLAttributes} from 'react';
import {CategoryFilter} from './CategoryFilter';
import styles from './Settings.module.css';

export const foldSearch=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim();
export function SearchField({value,onValueChange,...props}:Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'type'>&{value:string;onValueChange:(v:string)=>void}){
 return <div className={styles.searchField} data-search-field><Search size={17} aria-hidden="true"/><input {...props} type="search" value={value} onChange={e=>onValueChange(e.target.value)}/>{value&&<button type="button" disabled={props.disabled} aria-label="Очистить поиск" onClick={()=>onValueChange('')}><X size={16}/></button>}</div>;
}
export function SearchFilter({label,options,value,onChange,disabled,single}:{label:string;options:readonly (readonly [string,string])[];value:string[];onChange:(ids:string[])=>void;disabled:boolean;single?:boolean}){
 return <CategoryFilter categories={options.map(([id,name])=>({id,name,parentId:null,role:'both',hidden:false}))} value={value} onChange={onChange} disabled={disabled} emptyLabel={label} flatLabel={label} single={single}/>;
}
