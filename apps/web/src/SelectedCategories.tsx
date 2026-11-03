import {useState} from 'react';
import type {Category} from '../../../packages/finance-core/src/model';
import {selectedCategoryOptions} from '../../../packages/finance-core/src/selected-categories';
import type {SelectedCategoryKey} from '../../../packages/finance-core/src/selected-categories';
import type {WorkspaceIntent} from './workspace-command';
import common from './App.module.css';
import styles from './Workspace.module.css';
export function SelectedCategories({categories,disabled,begin}:{categories:Category[];disabled:boolean;begin:(intent:WorkspaceIntent,title:string,confirm?:boolean)=>void}){
 const [selected,setSelected]=useState<SelectedCategoryKey[]>([]),options=selectedCategoryOptions(categories),available=options.filter(o=>o.status==='create'),keys=selected.filter(k=>available.some(o=>o.key===k));
 if(!available.length&&!options.some(o=>o.status==='hidden'||o.status==='ambiguous'))return <p>Все дополнительные категории уже есть в вашей структуре.</p>;
 return <details><summary>Дополнительные категории</summary><p>Выберите нужные категории. Существующие подходящие категории будут использованы повторно. Изменения сначала появятся в предварительном просмотре.</p><fieldset className={styles.form} disabled={disabled}><legend>Что добавить</legend>{options.map(o=><label key={o.key}><input type="checkbox" checked={keys.includes(o.key)} disabled={o.status!=='create'} onChange={e=>setSelected(v=>e.target.checked?[...v,o.key]:v.filter(k=>k!==o.key))}/>{o.label}{o.status==='present'?' · Уже есть':o.status==='hidden'?' · Есть скрытая категория — покажите её вручную':o.status==='ambiguous'?' · Есть несколько подходящих категорий — проверьте структуру':''}</label>)}<button className={common.button} disabled={!keys.length} onClick={()=>begin({kind:'add_catalog_categories',keys},'Добавление выбранных категорий',true)}>Посмотреть изменения</button></fieldset></details>;
}
