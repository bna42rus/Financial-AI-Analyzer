import {SelectField} from './SelectField';
import {SearchFilter} from './SearchFilter';
import {DateInput} from './DateInput';
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
      <label>С даты<DateInput  aria-label="С даты" value={filters.start} aria-invalid={invalid} onValueChange={value=>value&&onChange({start:value})} /></label>
      <label>По дату<DateInput  aria-label="По дату" value={filters.end} aria-invalid={invalid} onValueChange={value=>value&&onChange({end:value})} /></label>
    </div>
    <label>Банк<SelectField aria-label="Банк" value={filters.bank} onChange={e=>onChange({bank:e.target.value,account:''})}><option value="">Все банки</option>{banks.map(bank=><option key={bank}>{bank}</option>)}</SelectField></label>
    <label>Счёт<SelectField aria-label="Счёт" value={filters.account} onChange={e=>onChange({account:e.target.value})}><option value="">Все счета</option>{accounts.map(account=><option key={account}>{account}</option>)}</SelectField></label>
    <div className={styles.categoryField}><span className={styles.fieldLabel}>Категории</span><SearchFilter aria-label="Категории" label="Все категории" options={categories.map(category=>[category,category])} value={[...filters.categories]} onChange={ids=>onChange({categories:ids})} disabled={false} fullWidth/></div>
  </section>;
}
