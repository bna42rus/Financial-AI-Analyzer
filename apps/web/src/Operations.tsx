import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCheck, Search, SlidersHorizontal, Upload, X } from 'lucide-react';
import { GlobalFilters } from './GlobalFilters';
import { formatDate, formatMoney } from './demo/overview';
import type { DemoOperation, OverviewFilters } from './demo/overview';
import { defaultOperationsView, operationList, roleLabels, selectRange, statusLabel } from './demo/operations';
import type { OperationsView, OperationScope, OperationSort, QuickFilter } from './demo/operations';
import common from './App.module.css';
import styles from './Operations.module.css';

interface Props {
  operations: readonly DemoOperation[];
  filters: OverviewFilters;
  view: OperationsView;
  scope: OperationScope | null;
  loading: boolean;
  onViewChange: (view: OperationsView) => void;
  onFilterChange: (update: Partial<OverviewFilters>) => void;
  onClearScope: () => void;
  onOpen: (row: DemoOperation) => void;
  onShowDemo: () => Promise<void>;
}
const quickFilters: readonly [QuickFilter,string][] = [['all','Все'],['attention','Требуют внимания'],['unresolved','Смысл не определён'],['excluded','Исключено']];

export function Operations({operations,filters,view,scope,loading,onViewChange,onFilterChange,onClearScope,onOpen,onShowDemo}:Props) {
  const [selected,setSelected] = useState<string[]>([]);
  const [anchor,setAnchor] = useState<string|null>(null);
  const [filterOpen,setFilterOpen] = useState(false);
  const allCheckbox = useRef<HTMLInputElement>(null);
  const list = useMemo(()=>operationList(operations,filters,view,scope),[operations,filters,view,scope]);
  const ids = list.rows.map(row=>row.id);
  const signature = [...ids].sort().join('|');
  const selectedVisible = selected.filter(id=>ids.includes(id));
  useEffect(()=>{setSelected(current=>current.filter(id=>ids.includes(id)));setAnchor(current=>current&&ids.includes(current)?current:null);},[signature]);
  useEffect(()=>{if(allCheckbox.current)allCheckbox.current.indeterminate=selectedVisible.length>0&&selectedVisible.length<ids.length;},[selectedVisible.length,ids.length]);
  function update(patch:Partial<OperationsView>){onViewChange({...view,...patch});}
  function choose(id:string,range=false){setSelected(current=>range?selectRange(ids,anchor,id,current):current.includes(id)?current.filter(value=>value!==id):[...current,id]);if(!range||!anchor)setAnchor(id);}
  function clickRow(event:MouseEvent<HTMLButtonElement>,row:DemoOperation){if(event.shiftKey||event.metaKey||event.ctrlKey)choose(row.id,event.shiftKey);else onOpen(row);}
  function keyboard(event:KeyboardEvent<HTMLElement>){
    const element=(event.target as HTMLElement).closest<HTMLElement>('[data-operation-row]');
    if(!element)return;
    const id=element.dataset.operationRow;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();setSelected(ids);setAnchor(ids[0]??null);return;}
    if(event.key===' '&&(event.target as HTMLElement).tagName!=='INPUT'){event.preventDefault();if(id)choose(id,event.shiftKey);return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();const position=ids.indexOf(id??'');const next=ids[Math.max(0,Math.min(ids.length-1,position+(event.key==='ArrowDown'?1:-1)))];
      if(next){if(event.shiftKey){setSelected(current=>selectRange(ids,anchor??id??null,next,current));if(!anchor)setAnchor(id??next);}event.currentTarget.querySelector<HTMLButtonElement>(`[data-operation-open="${next}"]`)?.focus();}
    }
  }
  function checkbox(row:DemoOperation){return <input type="checkbox" aria-label={`Выбрать: ${row.merchant}, ${formatDate(row.date)}`} checked={selectedVisible.includes(row.id)} onChange={()=>{}} onClick={event=>choose(row.id,event.shiftKey)} />;}
  function name(row:DemoOperation){return <button className={styles.merchant} data-operation-open={row.id} onClick={event=>clickRow(event,row)}>{row.merchant}</button>;}
  function tag(row:DemoOperation){return <span className={`${styles.badge} ${row.requiresAttention?styles.warning:''} ${row.excluded?styles.excluded:''}`}>{statusLabel(row)}</span>;}
  function extraFilters(){return <div className={styles.extraFilters}><label>Тип операции<select aria-label="Тип операции" value={view.kind} onChange={e=>update({kind:e.target.value})}><option value="">Все типы</option>{[...new Set(operations.map(row=>row.kind))].map(kind=><option key={kind}>{kind}</option>)}</select></label><label>Финансовый смысл<select aria-label="Финансовый смысл" value={view.role} onChange={e=>update({role:e.target.value})}><option value="">Любой смысл</option>{Object.entries(roleLabels).map(([role,label])=><option key={role} value={role}>{label}</option>)}</select></label></div>;}

  if(!operations.length)return <section className={common.empty}><div className={common.emptyIcon}><Upload size={26} aria-hidden="true" /></div><h2>Здесь будут ваши операции</h2><p>Загрузите выписку, чтобы искать записи и проверять их смысл, категории и суммы.</p><div className={common.emptyActions}><button className={common.primaryButton} disabled>Загрузить первую выписку</button><button className={common.button} disabled={loading} onClick={()=>void onShowDemo()}>{loading?'Открываем пример…':'Посмотреть пример'}</button></div><small>В примере используются только вымышленные операции.</small></section>;

  return <section aria-label="Список операций" className={styles.operations}>
    {scope&&<div className={styles.scope}><span>Из {scope.source??'Обзора'}: {scope.label}</span><button onClick={onClearScope}>Убрать ограничение <X size={14} aria-hidden="true" /></button></div>}
    <div className={styles.toolbar}><label className={styles.search}><Search size={18} aria-hidden="true" /><input type="search" aria-label="Поиск операций" placeholder="Поиск по операциям" value={view.query} onChange={e=>update({query:e.target.value})} /></label><button className={`${common.button} ${styles.mobileFilter}`} onClick={()=>setFilterOpen(true)}><SlidersHorizontal size={17} aria-hidden="true" />Фильтры</button><label className={styles.sort}>Сортировка<select aria-label="Сортировка" value={view.sort} onChange={e=>update({sort:e.target.value as OperationSort})}><option value="date-desc">Сначала новые</option><option value="date-asc">Сначала старые</option><option value="amount-desc">По сумме: больше → меньше</option><option value="amount-asc">По сумме: меньше → больше</option><option value="merchant">По названию</option></select></label></div>
    <div className={styles.quick} aria-label="Быстрые фильтры">{quickFilters.map(([key,label])=><button key={key} aria-pressed={view.quick===key} onClick={()=>update({quick:key})}>{label}<span>{list.counts[key]}</span></button>)}</div>
    <div className={styles.desktopExtra}>{extraFilters()}</div>
    {filters.start>filters.end&&<p className={common.error} role="alert">Начальная дата должна быть раньше конечной или совпадать с ней.</p>}
    {filters.start<=filters.end&&<><div className={styles.resultSummary}><span data-testid="operation-count">Показано {list.rows.length} из {list.rows.length}</span><span>Расходы <strong data-testid="operation-expenses">{formatMoney(list.totals.expenseMinor)}</strong></span><span>Доходы <strong data-testid="operation-income">{formatMoney(list.totals.incomeMinor)}</strong></span></div>
    {selectedVisible.length>0&&<div className={styles.selection} role="status"><span><CheckCheck size={17} aria-hidden="true" />Выбрано: {selectedVisible.length}</span><button onClick={()=>{setSelected([]);setAnchor(null);}}>Снять выбор</button><small>Массовое изменение будет доступно позже.</small></div>}
    {!list.rows.length?<div className={styles.noResults}><h2>Ничего не найдено</h2><p>Измените поиск или фильтры.</p><button className={common.button} onClick={()=>{onViewChange(defaultOperationsView);onClearScope();}}>Сбросить поиск и быстрые фильтры</button></div>:<>
      <div className={styles.tableWrap}><table className={styles.table} aria-label="Операции"><thead><tr><th><input ref={allCheckbox} type="checkbox" aria-label="Выбрать все найденные" checked={selectedVisible.length===ids.length} onChange={e=>{setSelected(e.target.checked?ids:[]);setAnchor(ids[0]??null);}} /></th><th>Дата</th><th>Операция</th><th className={styles.amount}>Сумма</th><th>Счёт</th><th>Тип</th><th>Учёт</th><th>Категория</th><th>Статус</th></tr></thead><tbody onKeyDown={keyboard}>{list.rows.map(row=><tr key={row.id} data-operation-row={row.id} data-testid={`operation-${row.id}`} className={selectedVisible.includes(row.id)?styles.selected:undefined}><td>{checkbox(row)}</td><td className={styles.date}>{formatDate(row.date)}</td><td>{name(row)}</td><td className={`${styles.amount} ${BigInt(row.amountMinor)>0n?styles.positive:''}`}>{formatMoney(row.amountMinor)}</td><td>{row.account}<small>{row.bank}</small></td><td>{row.kind}</td><td>{roleLabels[row.role]}</td><td>{row.category||'—'}</td><td>{tag(row)}</td></tr>)}</tbody></table></div>
      <div className={styles.cards} onKeyDown={keyboard}><div className={styles.selectAllMobile}><label><input type="checkbox" aria-label="Выбрать все найденные" checked={selectedVisible.length===ids.length} onChange={e=>{setSelected(e.target.checked?ids:[]);setAnchor(ids[0]??null);}} />Выбрать все найденные</label></div>{list.rows.map(row=><article className={`${styles.operationItem} ${selectedVisible.includes(row.id)?styles.selected:''}`} key={row.id} data-operation-row={row.id} data-testid={`operation-${row.id}`}><div className={styles.itemTop}>{checkbox(row)}{name(row)}<strong className={BigInt(row.amountMinor)>0n?styles.positive:''}>{formatMoney(row.amountMinor)}</strong></div><p>{formatDate(row.date)} · {row.account} · {row.bank}</p><p>{row.category||'Категория не задана'} · {row.kind} · {roleLabels[row.role]}</p>{tag(row)}</article>)}</div>
    </>}
    </>}
    <Dialog.Root open={filterOpen} onOpenChange={setFilterOpen}><Dialog.Portal><Dialog.Overlay className={common.overlay} /><Dialog.Content className={styles.filterSheet} aria-describedby="filters-description"><div className={styles.drawerHead}><Dialog.Title>Фильтры операций</Dialog.Title><Dialog.Close className={common.iconButton} aria-label="Закрыть фильтры"><X size={20} /></Dialog.Close></div><Dialog.Description id="filters-description">Период, банк, счёт и категории общие с Обзором.</Dialog.Description><GlobalFilters operations={operations} filters={filters} onChange={onFilterChange} />{filters.start>filters.end&&<p className={common.error} role="alert">Начальная дата должна быть раньше конечной или совпадать с ней.</p>}{extraFilters()}<Dialog.Close disabled={filters.start>filters.end} className={common.primaryButton}>Показать операции</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
