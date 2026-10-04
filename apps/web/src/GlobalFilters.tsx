import type { DemoOperation, OverviewFilters } from './demo/overview';
import styles from './App.module.css';

interface Props {
  operations: readonly DemoOperation[];
  filters: OverviewFilters;
  onChange: (update: Partial<OverviewFilters>) => void;
}
export function GlobalFilters({operations,filters,onChange}: Props) {
  const banks = [...new Set(operations.map(row=>row.bank))];
  const accounts = [...new Set(operations.filter(row=>!filters.bank||row.bank===filters.bank).map(row=>row.account))];
  const categories = [...new Set(operations.map(row=>row.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  const invalid = filters.start > filters.end;
  return <section className={styles.filters} aria-label="Глобальные фильтры">
    <div className={styles.dateFields}>
      <label>С даты<input type="date" aria-label="С даты" value={filters.start} aria-invalid={invalid} onChange={e=>e.target.value&&onChange({start:e.target.value})} /></label>
      <label>По дату<input type="date" aria-label="По дату" value={filters.end} aria-invalid={invalid} onChange={e=>e.target.value&&onChange({end:e.target.value})} /></label>
    </div>
    <label>Банк<select aria-label="Банк" value={filters.bank} onChange={e=>onChange({bank:e.target.value,account:''})}><option value="">Все банки</option>{banks.map(bank=><option key={bank}>{bank}</option>)}</select></label>
    <label>Счёт<select aria-label="Счёт" value={filters.account} onChange={e=>onChange({account:e.target.value})}><option value="">Все счета</option>{accounts.map(account=><option key={account}>{account}</option>)}</select></label>
    <div className={styles.categoryField}><span className={styles.fieldLabel}>Категории</span><details className={styles.categoryPicker}><summary>{filters.categories.length?`Выбрано: ${filters.categories.length}`:'Все категории'}<span aria-hidden="true">⌄</span></summary><div className={styles.popover}>{categories.length?<><button onClick={()=>onChange({categories:[]})}>Все категории</button>{categories.map(category=><label key={category}><input type="checkbox" checked={filters.categories.includes(category)} onChange={e=>onChange({categories:e.target.checked?[...filters.categories,category]:filters.categories.filter(c=>c!==category)})} />{category}</label>)}</>:<p>Категории появятся после загрузки данных.</p>}</div></details></div>
  </section>;
}
