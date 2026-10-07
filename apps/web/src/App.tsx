import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, ChartNoAxesCombined, CircleAlert, LayoutDashboard, List, Settings2, Sparkles, Upload, UserRound, X } from 'lucide-react';
import { barPercent, createOverview, emptyFilters, formatDate, formatMoney, weekBuckets } from './demo/overview';
import type { DemoOperation, OverviewFilters } from './demo/overview';
import styles from './App.module.css';
import { GlobalFilters } from './GlobalFilters';
import { Operations } from './Operations';
import { OperationCard } from './OperationCard';
import { defaultOperationsView } from './demo/operations';
import type { OperationsView, OperationScope } from './demo/operations';
import { Analyzer } from './Analyzer';
import { newChatBook } from './demo/analyzer';
import type { ChatBook } from './demo/analyzer';
import { Settings, defaultAppearance } from './Settings';
import type { Appearance } from './Settings';

type Detail = { title: string; description: string; rows: readonly DemoOperation[]; calculation?: boolean };
type Screen = 'overview'|'operations'|'analyzer'|'settings';
const currentScreen = ():Screen => /^#settings(?:\/|$)/.test(window.location.hash)?'settings':window.location.hash==='#analyzer'?'analyzer':window.location.hash==='#operations'?'operations':'overview';
const absolute = (minor: string) => BigInt(minor) < 0n ? -BigInt(minor) : BigInt(minor);
const maximum = (values: readonly string[]) => values.reduce((max, value) => absolute(value) > max ? absolute(value) : max, 0n);

function thisMonth(): OverviewFilters {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  return { ...emptyFilters, start: `${y}-${String(m + 1).padStart(2,'0')}-01`, end: `${y}-${String(m + 1).padStart(2,'0')}-${new Date(y,m+1,0).getDate()}` };
}

export function App() {
  const [operations, setOperations] = useState<readonly DemoOperation[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<OverviewFilters>(thisMonth);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [screen,setScreen] = useState<Screen>(currentScreen);
  const [appearance,setAppearance] = useState<Appearance>(()=>({...defaultAppearance}));
  useEffect(()=>{
    const root=document.documentElement;
    root.dataset.theme=appearance.theme;root.dataset.density=appearance.density;
    root.dataset.textSize=appearance.textSize;root.dataset.motion=appearance.motion;
  },[appearance]);
  const [chatBook,setChatBook] = useState<ChatBook>(newChatBook);
  const [operationsView,setOperationsView] = useState<OperationsView>(defaultOperationsView);
  const [scope,setScope] = useState<OperationScope|null>(null);
  const [operationCard,setOperationCard] = useState<DemoOperation|null>(null);
  useEffect(()=>{
    const restore=()=>{setScreen(currentScreen());setDetail(null);setOperationCard(null);};
    window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore);
    return()=>{window.removeEventListener('popstate',restore);window.removeEventListener('hashchange',restore);};
  },[]);
  function navigate(next:Screen){
    setScreen(next);setDetail(null);setOperationCard(null);
    if(window.location.hash!=='#'+next){window.history.pushState(null,'','#'+next);window.dispatchEvent(new HashChangeEvent('hashchange'));}
  }
  const overview = useMemo(() => createOverview(operations, filters), [operations, filters]);
  const periods = useMemo(() => weekBuckets(operations, filters), [operations, filters]);
  const categoryMax = maximum(overview.categories.map(row => row.amountMinor));
  const periodMax = maximum(periods.map(row => row.amountMinor));
  const centeredCategories = overview.categories.some(row => BigInt(row.amountMinor) < 0n);
  const centeredPeriods = periods.some(row => BigInt(row.amountMinor) < 0n);
  const invalidPeriod = filters.start > filters.end;

  async function showDemo() {
    setLoading(true);
    try {
      const fixtures = await import('./demo/fixtures');
      setOperations(fixtures.demoOperations); setFilters(emptyFilters); setDemo(true); setOperationsView(defaultOperationsView); setScope(null);
    } finally { setLoading(false); }
  }
  function clearDemo() { setOperations([]); setFilters(thisMonth()); setDetail(null); setDemo(false); setOperationCard(null); setScope(null); setOperationsView(defaultOperationsView); setChatBook(newChatBook()); }
  function updateFilters(update: Partial<OverviewFilters>) { setFilters(current => ({ ...current, ...update })); setDetail(null); setOperationCard(null); setScope(null); }
  function showRows(title: string, rows: readonly DemoOperation[]) {
    setScope({label:title,ids:rows.map(row=>row.id)});setOperationsView(defaultOperationsView);navigate('operations');
  }
  function renderBar(minor: string, max: bigint, centered: boolean) {
    const negative = BigInt(minor) < 0n;
    return <div className={`${styles.track} ${centered ? styles.centered : ''}`} aria-hidden="true">
      <span className={styles.fill} style={{ width: barPercent(minor,max,centered), ...(centered ? negative ? { right:'50%' } : { left:'50%' } : { left:0 }) }} />
    </div>;
  }

  return <div className={styles.app}>
    <a className={styles.skip} href={`#${screen}`}>Перейти к содержимому</a>
    <header className={styles.header}>
      <a href="#overview" onClick={event=>{event.preventDefault();navigate("overview");}} className={styles.brand}><span className={styles.brandMark}><ChartNoAxesCombined size={19} aria-hidden="true" /></span><span>Финансовый анализатор<span className={styles.brandNote}>Первая версия интерфейса</span></span></a>
      <div className={styles.headerActions}><button className={styles.primaryButton} disabled><Upload size={17} aria-hidden="true" /><span className={styles.uploadLabel}>Загрузить файлы</span></button><button className={styles.button} disabled aria-label="Профиль"><UserRound size={17} aria-hidden="true" /></button></div>
      <nav className={styles.nav} aria-label="Разделы сайта">
        <a href="#overview" onClick={event=>{event.preventDefault();navigate("overview");}} aria-current={screen==='overview'?'page':undefined}><LayoutDashboard size={17} aria-hidden="true" />Обзор</a>
        <a href="#operations" onClick={event=>{event.preventDefault();setScope(null);navigate("operations");}} aria-current={screen==='operations'?'page':undefined}><List size={17} aria-hidden="true" />Операции</a>
        <a href="#analyzer" onClick={event=>{event.preventDefault();navigate('analyzer');}} aria-current={screen==='analyzer'?'page':undefined}><Sparkles size={17} aria-hidden="true" />Анализатор</a>
        <a href="#settings" onClick={event=>{event.preventDefault();navigate('settings');}} aria-current={screen==='settings'?'page':undefined}><Settings2 size={17} aria-hidden="true" />Настройки</a>
      </nav>
    </header>
    <main id={screen} className={`${styles.main} ${screen==='analyzer'?styles.analyzerMain:''}`}>
      {demo && <div className={styles.demoBanner}><span>Демонстрационный режим · вымышленные данные</span><button onClick={clearDemo}>Закрыть пример <X size={15} aria-hidden="true" /></button></div>}
      {screen!=='settings' && <div className={screen==='operations'||screen==='analyzer'?styles.operationFilters:undefined}><GlobalFilters operations={operations} filters={filters} onChange={updateFilters} /></div>}
      <div className={styles.titleLine}><div><h1>{screen==='overview'?'Обзор':screen==='operations'?'Операции':screen==='settings'?'Настройки':'Анализатор'}</h1><p>{screen==='settings'?'Ваши счета, правила и удобное оформление':screen==='analyzer'?'Вопросы о ваших финансах':`${formatDate(filters.start)} — ${formatDate(filters.end)} ${filters.end.slice(0,4)}`}</p></div>{demo && screen!=='analyzer' && screen!=='settings' && <button className={styles.button} onClick={() => {updateFilters(emptyFilters);setOperationsView(defaultOperationsView);}}>Сбросить фильтры</button>}</div>
      {screen==='settings' ? <Settings operations={operations} appearance={appearance} loading={loading} onAppearanceChange={setAppearance} onShowDemo={showDemo} onOpenOperations={(label,rows)=>{const dates=rows.map(row=>row.date).sort();setFilters({...emptyFilters,start:dates[0]??emptyFilters.start,end:dates.at(-1)??emptyFilters.end});setScope({label,ids:rows.map(row=>row.id),source:'Настроек'});setOperationsView(defaultOperationsView);navigate('operations');}} /> : screen==='analyzer' ? <Analyzer operations={operations} filters={filters} book={chatBook} loading={loading} onBookChange={setChatBook} onFilterChange={updateFilters} onShowDemo={showDemo} onOpenOperations={result=>{setFilters(result.filters);setScope({label:result.key==='attention'?'Требуют внимания':result.key==='largest'?'Крупнейшие расходы':'Учтённые расходы',ids:result.operationIds,source:'Анализатора'});setOperationsView(defaultOperationsView);navigate('operations');}} /> : screen==='operations' ? <Operations operations={operations} filters={filters} view={operationsView} scope={scope} loading={loading} onViewChange={setOperationsView} onFilterChange={updateFilters} onClearScope={()=>setScope(null)} onOpen={setOperationCard} onShowDemo={showDemo} /> : invalidPeriod ? <p className={styles.error} role="alert">Начальная дата должна быть раньше конечной или совпадать с ней.</p> : !operations.length ? <section className={styles.empty} aria-labelledby="empty-title"><div className={styles.emptyIcon}><Upload size={26} aria-hidden="true" /></div><h2 id="empty-title">Начните с первой выписки</h2><p>Здесь появятся ваши расходы, доходы и понятные графики по нескольким банкам.</p><div className={styles.emptyActions}><button className={styles.primaryButton} disabled><Upload size={16} aria-hidden="true" />Загрузить первую выписку</button><button className={styles.button} onClick={() => void showDemo()} disabled={loading}>{loading ? 'Открываем пример…' : 'Посмотреть пример'}</button></div><small>В примере используются только вымышленные операции.</small></section> : <>
        <section className={styles.stats} aria-label="Основные показатели">
          <button className={styles.stat} onClick={() => setDetail({ title:'Как рассчитаны расходы', description:'Возвраты уменьшают расходы. Собственные и неразобранные переводы, а также исключённые операции в эту сумму не входят.', rows:overview.matching, calculation:true })}><span className={styles.statLabel}>Расходы</span><strong data-testid="expenses">{formatMoney(overview.expenseMinor)}</strong><small>{overview.offsetsMinor !== '0' ? `С учётом возвратов ${formatMoney(overview.offsetsMinor)}` : 'Возвратов в периоде нет'}</small></button>
          <button className={styles.stat} onClick={() => showRows('Доходы',overview.matching.filter(row => row.role === 'income' && !row.excluded))}><span className={styles.statLabel}>Доходы</span><strong data-testid="income">{formatMoney(overview.incomeMinor)}</strong><small>Учтённые поступления</small></button>
          <div className={styles.stat}><span className={styles.statLabel}>Разница</span><strong data-testid="difference">{formatMoney(overview.differenceMinor)}</strong><small>Доходы минус расходы</small></div>
          <button className={`${styles.stat} ${styles.attention}`} onClick={() => showRows('Требуют внимания',overview.matching.filter(row => row.requiresAttention))}><span className={styles.statLabel}><CircleAlert size={16} aria-hidden="true" />Требуют внимания</span><strong data-testid="attention">{overview.attention}</strong><small>Показать операции <ArrowRight size={13} aria-hidden="true" /></small></button>
        </section>
        {!overview.matching.length ? <section className={styles.noResults}><h2>За выбранный период операций нет</h2><p>Измените период, банк, счёт или категории.</p><button className={styles.button} onClick={() => updateFilters(emptyFilters)}>Показать все примеры</button></section> : <>
          <div className={styles.columns}>
            <section className={styles.panel} aria-labelledby="category-title"><div className={styles.panelHead}><h2 id="category-title">Расходы по категориям</h2><span>₽</span></div><div className={styles.chartRows}>{overview.categories.length ? overview.categories.map(category => <button className={styles.chartRow} key={category.name} onClick={() => showRows(category.name,overview.matching.filter(row => row.category === category.name && row.role === 'expense' && !row.excluded))}><span className={styles.barLabel}><span>{category.name}</span><span>{formatMoney(category.amountMinor)}</span></span>{renderBar(category.amountMinor,categoryMax,centeredCategories)}</button>) : <p className={styles.muted}>Расходов в этой выборке нет.</p>}</div><p className={styles.chartNote}>Возвраты уменьшают расходы своей категории.</p></section>
            <section className={styles.panel} aria-labelledby="period-title"><div className={styles.panelHead}><h2 id="period-title">Динамика расходов</h2><span>₽</span></div><div className={styles.chartRows}>{periods.map(period => <button className={styles.chartRow} key={period.from} onClick={() => showRows(`${formatDate(period.from)} — ${formatDate(period.to)}`,overview.matching.filter(row => row.date >= period.from && row.date <= period.to))}><span className={styles.barLabel}><span>{formatDate(period.from)} — {formatDate(period.to)}</span><span>{formatMoney(period.amountMinor)}</span></span>{renderBar(period.amountMinor,periodMax,centeredPeriods)}</button>)}</div><p className={styles.chartNote}>Точные суммы доступны текстом и по нажатию на период.</p></section>
          </div>
          <section className={`${styles.panel} ${styles.largest}`} aria-labelledby="largest-title"><div className={styles.panelHead}><h2 id="largest-title">Крупнейшие расходы</h2><button className={styles.linkButton} onClick={() => showRows('Все операции',overview.matching)}>Все операции <ArrowRight size={16} aria-hidden="true" /></button></div>{overview.largest.length ? overview.largest.map(row => <button className={styles.topRow} key={row.id} onClick={() => showRows(row.merchant,[row])}><span><span>{row.merchant}</span><small>{row.category} · {formatDate(row.date)} · {row.account}</small></span><span>{formatMoney((-BigInt(row.amountMinor)).toString())} <span aria-hidden="true">›</span></span></button>) : <p className={styles.muted}>В выборке нет списаний, учитываемых как расходы.</p>}</section>
        </>}
      </>}
      {screen!=='analyzer'&&<footer className={styles.footer}><span>Суммы в рублях · разница не является банковским балансом</span></footer>}
    </main>
    <OperationCard row={operationCard} onClose={()=>setOperationCard(null)} />
    <Dialog.Root open={detail !== null} onOpenChange={open => !open && setDetail(null)}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog} aria-describedby="detail-description"><div className={styles.dialogHead}><Dialog.Title>{detail?.title}</Dialog.Title><Dialog.Close className={styles.iconButton} aria-label="Закрыть"><X size={20} /></Dialog.Close></div><Dialog.Description id="detail-description">{detail?.description}</Dialog.Description>{detail?.calculation ? <dl className={styles.breakdown}><div><dt>Расходы до возвратов</dt><dd>{formatMoney(overview.grossMinor)}</dd></div><div><dt>Возвраты</dt><dd>−{formatMoney(overview.offsetsMinor)}</dd></div><div><dt>Итого расходы</dt><dd>{formatMoney(overview.expenseMinor)}</dd></div><div><dt>Исключено операций</dt><dd>{overview.excludedCount}</dd></div><div><dt>Нейтральные операции</dt><dd>{overview.neutralCount}</dd></div><div><dt>Не определён смысл</dt><dd>{overview.unresolvedCount}</dd></div></dl> : <ul className={styles.detailRows}>{detail?.rows.length ? detail.rows.map(row => <li key={row.id}><div><strong>{row.merchant}</strong><small>{formatDate(row.date)} · {row.bank} · {row.account}</small><small>{row.category || (row.role === 'neutral' ? 'Не учитывается' : 'Смысл не определён')}{row.excluded ? ' · Исключено' : ''}</small></div><span>{formatMoney(row.amountMinor)}</span></li>) : <li>Операций в этой выборке нет.</li>}</ul>}<Dialog.Close className={styles.button}>Закрыть</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
