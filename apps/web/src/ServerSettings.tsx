import {AccountStructure,SettingsAccounts} from './SettingsAccounts';
import {NavigationPreferences} from './NavigationPreferences';
import type {NavigationPreferences as NavigationPreferencesValue} from './navigation-preferences';
import {SettingsEntityDialog} from './SettingsEntities';
import type {EntityEditor} from './SettingsEntities';
import {OperationField} from './OperationDialog';
import {TimezoneSettings} from './TimezoneSettings';
import {CategoryTree} from './CategoryTree';
import {CategoryBindings} from './CategoryBindings';
import {ServerBudgets} from './ServerBudgets';
import {SelectedCategories} from './SelectedCategories';
import type {OperationsFilter} from '../../../packages/finance-core/src/operations';
import {SavedOperationsViews} from './SavedOperationsViews';
import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {ArrowLeft,Search,X} from 'lucide-react';
import {AppearanceControls,defaultAppearance,sections} from './Settings';
import type {Appearance} from './Settings';
import type {FinanceState} from './finance-client';
import type {WorkspaceCommand,WorkspaceIntent,CommandState} from './workspace-command';
import {SettingsStructure} from './SettingsStructure';
import type {StructureEditor} from './SettingsStructure';
import type {DeletionSelection} from './ServerDeletion';
import {SettingsRules} from './SettingsRules';
import {ServerHistory} from './ServerHistory';
import common from './App.module.css';
import styles from './Settings.module.css';
export function ServerSettings({state,section,navigate,command,commandState,disabled,appearance,onAppearance,onTimezone,navigationPreferences,onNavigationPreferences,imports,timezone,historyOperationId,onClearHistory,onAccessError,onAccount,onOperations,onBudgetOperations,onDelete,onNavigationGuard}:{onNavigationGuard:(guard:((action:()=>void)=>boolean)|null)=>void;state:FinanceState;section:string|null;navigate:(hash:string)=>void;command:WorkspaceCommand|null;commandState:CommandState;disabled:boolean;appearance:Appearance;onAppearance:(v:Appearance)=>void;onTimezone:(timezone:string)=>Promise<void>;navigationPreferences:NavigationPreferencesValue;onNavigationPreferences:(value:NavigationPreferencesValue)=>void;imports:ReactNode;timezone:string;historyOperationId:string|null;onClearHistory:()=>void;onAccessError:(e:unknown)=>void;onAccount:()=>void;onOperations:(accountId:string|null,excluded?:boolean)=>void;onBudgetOperations:(filter:OperationsFilter,name:string)=>void;onDelete:(selection:DeletionSelection)=>void}){
 const [query,setQuery]=useState(''),[entity,setEntity]=useState<EntityEditor|null>(null),[editor,setEditor]=useState<StructureEditor|null>(null);const heading=useRef<HTMLHeadingElement>(null),menu=useRef<HTMLElement>(null);const current=sections.find(s=>s.id===section)??sections[0];
 useEffect(()=>{setEditor(null);setEntity(null);if(section)heading.current?.focus({preventScroll:true});},[section]);
 function begin(intent:WorkspaceIntent,title:string,confirm=false){
  const labels:Record<string,string>={name:'Название',type:'Тип счёта',analyticsEnabled:'Участие в аналитике',defaultVisible:'Показывать по умолчанию',loanMode:'Учёт кредита',role:'Смысл',parentId:'Родительская категория',hidden:'Скрыта',state:'Статус',isSelf:'Свой контрагент'};
  const values:Record<string,string>={debit_card:'Дебетовая карта',credit_card:'Кредитная карта',bank_account:'Текущий счёт',loan:'Кредит',savings:'Накопительный счёт',deposit:'Вклад',other:'Другой',cashflow:'Весь платёж как расход',economic:'Проценты и сопутствующие расходы',expense:'Расходы',income:'Доходы',both:'Расходы и доходы',registered:'Зарегистрирован',ignored:'Игнорируется'};
  const entity='id'in intent?state.accounts.find(a=>a.id===intent.id)??state.categories.find(c=>c.id===intent.id)??state.counterparties.find(p=>p.id===intent.id):null;
  const describe=(v:unknown,k:string)=>k==='name'?String(v):typeof v==='boolean'?(v?'Да':'Нет'):v===null?(k==='parentId'?'Корневая категория':'По умолчанию'):state.categories.find(c=>c.id===v)?.name??values[String(v)]??String(v);
  const changes='patch'in intent?Object.entries(intent.patch??{}).map(([k,v])=>(labels[k]??'Настройка')+': '+describe(v,k)).join('; '):'';
  void command?.begin(intent,title+(entity?' «'+entity.name+'»':'')+(changes?'. '+changes:''),confirm);
 }
 const filtered=sections.filter(s=>(s.title+' '+s.keywords).toLocaleLowerCase('ru-RU').replaceAll('ё','е').includes(query.toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim()));
 function partyCard(p:FinanceState['counterparties'][number]){
  return <article key={p.id} className={styles.settingsRow}><div><strong>{p.name}</strong>{p.isSelf&&<small>Свой контрагент</small>}</div><div className={styles.cardActions}>
   <button className={common.button} disabled={disabled} onClick={()=>setEntity({kind:'counterparty',id:p.id})}>Изменить</button>
   <button className={common.button} disabled={disabled} onClick={()=>setEditor({kind:'counterparty',id:p.id})}>Структура</button>
   <button className={common.dangerButton} disabled={disabled} onClick={()=>onDelete({kind:'counterparty',id:p.id})}>Удалить данные</button>
  </div></article>;
 }
 function content(){switch(current.id){
 case 'accounts':return <SettingsAccounts commandState={commandState} onNavigationGuard={onNavigationGuard} state={state} disabled={disabled} command={command} openOperations={onOperations} openStructure={id=>setEditor({kind:'account',id})} openDeletion={id=>onDelete({kind:'account',id})}/>;
 case 'imports':return imports;
 case 'categories':return <div className={styles.settingsStack}>
  <div className={styles.cardActions}><button className={common.primaryButton} disabled={disabled} onClick={()=>setEntity({kind:'category'})}>Добавить категорию</button></div>
  <CategoryTree categories={state.categories} renderItem={c=><article key={c.id} className={styles.settingsRow}><div><strong>{c.name}</strong>{c.hidden&&<small>Скрыта</small>}</div><div className={styles.cardActions}><button className={common.button} disabled={disabled} aria-label={'Изменить категорию: '+c.name} onClick={()=>setEntity({kind:'category',id:c.id})}>Изменить</button><button className={common.button} disabled={disabled} aria-label={'Структура категории: '+c.name} onClick={()=>setEditor({kind:'category',id:c.id})}>Структура</button></div></article>}/>
  <div className={styles.settingsBox}><CategoryBindings state={state} disabled={disabled} begin={begin}/><SelectedCategories categories={state.categories} disabled={disabled} begin={begin}/></div>
 </div>;
 case 'counterparties':return <div className={styles.settingsStack}>
  <div className={styles.cardActions}><button className={common.primaryButton} disabled={disabled} onClick={()=>setEntity({kind:'counterparty'})}>Добавить контрагента</button></div>
  {state.counterparties.some(p=>p.state==='registered')?<div className={styles.settingsList}>{state.counterparties.filter(p=>p.state==='registered').map(partyCard)}</div>:<p className={styles.emptyState}>Зарегистрированных контрагентов пока нет.</p>}
  {(['discovered','ignored'] as const).map(status=>{const rows=state.counterparties.filter(p=>p.state===status);return rows.length>0&&<details key={status} className={styles.settingsBox}><summary>{status==='discovered'?'Предложения':'Игнорируемые'} · {rows.length}</summary>{rows.map(partyCard)}</details>;})}
 </div>;
 case 'rules':return <SettingsRules state={state} command={command} commandState={commandState} disabled={disabled}/>;
 case 'budgets':return <ServerBudgets state={state} command={command} commandState={commandState} disabled={disabled} timezone={timezone} onAccessError={onAccessError} onOperations={onBudgetOperations}/>;
 case 'analytics':return <div className={styles.settingsStack}><section className={styles.settingsBox}><h3>Кредиты</h3><OperationField label="Общая модель учёта"><select disabled={disabled||!state.loanMode} value={state.loanMode??''} onChange={e=>begin({kind:'analytics',value:e.target.value as 'cashflow'|'economic'},e.target.value==='cashflow'?'Учитывать весь платёж по кредиту':'Учитывать проценты и сопутствующие расходы',true)}>{!state.loanMode&&<option value="">Недоступно</option>}<option value="cashflow">Весь платёж как расход</option><option value="economic">Проценты и сопутствующие расходы</option></select></OperationField><p className={styles.muted}>Для отдельного кредита модель можно изменить в настройках счёта.</p></section><section className={styles.settingsBox}><h3>Исключённые операции</h3><p className={styles.muted}>Они остаются в списке, но не входят в стандартные итоги.</p><div className={styles.cardActions}><button className={common.button} disabled={disabled} onClick={()=>onOperations(null,true)}>Показать исключённые операции</button></div></section></div>;
 case 'interface':return <div className={styles.settingsStack}><div className={styles.settingsBox}><NavigationPreferences value={navigationPreferences} onChange={onNavigationPreferences} disabled={disabled}/></div><section className={styles.settingsBox}><h3>Оформление</h3><AppearanceControls appearance={appearance} onAppearanceChange={onAppearance}/><div className={styles.cardActions}><button className={styles.textButton} disabled={disabled||JSON.stringify(appearance)===JSON.stringify(defaultAppearance)} onClick={()=>onAppearance({...defaultAppearance})}>По умолчанию</button></div></section><TimezoneSettings timezone={timezone} disabled={disabled} onSave={onTimezone}/><SavedOperationsViews state={state} command={command} commandState={commandState} disabled={disabled} timezone={timezone} onAccessError={onAccessError} onOpen={screen=>navigate('#'+screen)}/></div>;
 case 'privacy':return <div className={styles.settingsStack}><section className={styles.settingsBox}><h3>Защита данных</h3><p>Выписки читаются на устройстве. Исходные файлы, пароли PDF и номера карт не отправляются на сервер.</p><div className={styles.cardActions}><button className={common.button} disabled={disabled} onClick={onAccount}>Аккаунт и безопасность</button></div></section><section className={styles.settingsBox}><h3>Удаление данных</h3><p className={styles.muted}>Перед удалением можно проверить состав. Удалённые данные нельзя вернуть через историю.</p><div className={styles.cardActions}><button className={common.dangerButton} disabled={disabled} onClick={()=>onDelete({kind:'period'})}>Удалить за период</button><button className={common.dangerButton} disabled={disabled} onClick={()=>onDelete({kind:'reset'})}>Полный финансовый сброс</button></div></section></div>;
 case 'history':return <ServerHistory state={state} command={command} disabled={disabled} timezone={timezone} operationId={historyOperationId} onClearScope={onClearHistory} onAccessError={onAccessError}/>;
 }}
 return <section className={`${styles.settings} ${section?styles.detailOpen:''}`} aria-label="Настройки сайта"><aside className={styles.sidebar}><div className={styles.search}><Search size={17}/><input placeholder="Поиск настроек" aria-label="Поиск настроек" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="Очистить поиск настроек" onClick={()=>setQuery('')}><X size={16}/></button>}</div><nav className={styles.menu} ref={menu} tabIndex={-1} aria-label="Подразделы настроек">{filtered.map(s=><button key={s.id} disabled={disabled} aria-current={current.id===s.id?'page':undefined} onClick={()=>navigate('#settings/'+s.id)}><s.icon size={19}/><span><strong>{s.title}</strong><small>{s.description}</small></span></button>)}</nav>{!filtered.length&&<p className={styles.noResults}>Ничего не найдено. Измените запрос.</p>}</aside><div className={styles.detail}><button className={`${common.button} ${styles.back}`} disabled={disabled} onClick={()=>{navigate('#settings');queueMicrotask(()=>menu.current?.focus());}}><ArrowLeft size={16}/>Все настройки</button><div className={styles.sectionHead}><div className={styles.sectionIcon}><current.icon size={20}/></div><div><h2 tabIndex={-1} ref={heading}>{current.title}</h2></div></div>{editor&&(editor.kind==='account'?<AccountStructure key={editor.id} state={state} command={command} commandState={commandState} disabled={disabled} id={editor.id} close={()=>setEditor(null)} onAccessError={onAccessError}/>:<SettingsStructure key={editor.kind+editor.id} state={state} command={command} disabled={disabled} editor={{kind:editor.kind,id:editor.id}} close={()=>setEditor(null)}/>)} {entity&&<SettingsEntityDialog key={entity.kind+(entity.id??'new')} editor={entity} state={state} command={command} commandState={commandState} disabled={disabled} close={()=>setEntity(null)}/>}<div className={styles.settingsContent}>{content()}</div></div></section>;
}
