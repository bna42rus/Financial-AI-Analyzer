import {SelectField} from './SelectField';
import {SettingsOperationPicker} from './SettingsOperationPicker';
import {AccountStructure,SettingsAccounts} from './SettingsAccounts';
import {InterfaceSettings} from './InterfaceSettings';
import type {NavigationPreferences as NavigationPreferencesValue} from './navigation-preferences';
import {SettingsEntityDialog} from './SettingsEntities';
import type {EntityEditor} from './SettingsEntities';
import {OperationField} from './OperationDialog';
import {CategoryTree} from './CategoryTree';
import {ServerBudgets} from './ServerBudgets';
import type {OperationsFilter} from '../../../packages/finance-core/src/operations';
import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {ArrowLeft,Settings2} from 'lucide-react';
import {foldSearch,SearchField} from './SearchFilter';
import {sections} from './Settings';
import type {Appearance} from './Settings';
import type {FinanceState} from './finance-client';
import type {WorkspaceCommand,WorkspaceIntent,CommandState} from './workspace-command';
import {SettingsStructure} from './SettingsStructure';
import type {StructureEditor} from './SettingsStructure';
import type {DeletionSelection} from './ServerDeletion';
import {RuleEditor,SettingsRules} from './SettingsRules';
import {ServerHistory} from './ServerHistory';
import common from './App.module.css';
import styles from './Settings.module.css';
const noOperations:string[]=[];
export function ServerSettings({state,section,navigate,command,commandState,disabled,appearance,onAppearance,navigationPreferences,onNavigationPreferences,imports,timezone,historyOperationId,onClearHistory,onAccessError,onAccount,onOperations,onBudgetOperations,onPartyOperations,onDelete,onNavigationGuard}:{onNavigationGuard:(guard:((action:()=>void)=>boolean)|null)=>void;state:FinanceState;section:string|null;navigate:(hash:string)=>void;command:WorkspaceCommand|null;commandState:CommandState;disabled:boolean;appearance:Appearance;onAppearance:(v:Appearance)=>void;onTimezone:(timezone:string)=>Promise<void>;navigationPreferences:NavigationPreferencesValue;onNavigationPreferences:(value:NavigationPreferencesValue)=>void;imports:ReactNode;timezone:string;historyOperationId:string|null;onClearHistory:()=>void;onAccessError:(e:unknown)=>void;onAccount:()=>void;onOperations:(accountId:string|null,excluded?:boolean)=>void;onBudgetOperations:(filter:OperationsFilter,name:string)=>void;onPartyOperations:(id:string,name:string)=>void;onDelete:(selection:DeletionSelection)=>void}){
 const [picker,setPicker]=useState<{kind:'exclude'|'party'|'proposal';id?:string;revision:string}|null>(null);
 const [proposalSelectionRevision,setProposalSelectionRevision]=useState<string|null>(null);
 const pickerTitle=picker?.kind==='exclude'?'Исключение операций':picker?.kind==='proposal'?'Сохранить выбор операций':'Привязать операции к контрагенту';
 const proposalParty=picker?.kind==='proposal'?state.counterparties.find(p=>p.id===picker.id):undefined;
 const [openedPartyRule,setOpenedPartyRule]=useState<string|null>(null);
 const [partyQuery,setPartyQuery]=useState(''),[partyType,setPartyType]=useState('all'),[partyTab,setPartyTab]=useState<'saved'|'suggestions'>('saved');
 const [query,setQuery]=useState(''),[entity,setEntity]=useState<EntityEditor|null>(null),[editor,setEditor]=useState<StructureEditor|null>(null);const heading=useRef<HTMLHeadingElement>(null),menu=useRef<HTMLElement>(null);const current=sections.find(s=>s.id===section)??sections[0];
 useEffect(()=>{setEditor(null);setEntity(null);setPicker(null);setOpenedPartyRule(null);if(section)heading.current?.focus({preventScroll:true});},[section]);
 useEffect(()=>{
  if(!picker||picker.revision===state.revision)return;
  if(picker.kind==='proposal'&&commandState.title===pickerTitle&&commandState.message){
   if(commandState.phase==='sending')return;
   if(commandState.phase==='idle'&&!commandState.error&&BigInt(state.revision)===BigInt(picker.revision)+1n)setProposalSelectionRevision(state.revision);
  }
  setPicker(null);
 },[picker,pickerTitle,state.revision,commandState]);
 function openEntity(next:EntityEditor){setProposalSelectionRevision(null);setEntity(next);}
 function begin(intent:WorkspaceIntent,title:string,confirm=false){
  const labels:Record<string,string>={name:'Название',type:'Тип счёта',analyticsEnabled:'Участие в аналитике',defaultVisible:'Показывать по умолчанию',loanMode:'Учёт кредита',role:'Смысл',parentId:'Родительская категория',hidden:'Скрыта',state:'Статус',isSelf:'Это я'};
  const values:Record<string,string>={debit_card:'Дебетовая карта',credit_card:'Кредитная карта',bank_account:'Текущий счёт',loan:'Кредит',savings:'Накопительный счёт',deposit:'Вклад',other:'Другой',cashflow:'Весь платёж как расход',economic:'Проценты и сопутствующие расходы',expense:'Расходы',income:'Доходы',both:'Расходы и доходы',registered:'Зарегистрирован',ignored:'Игнорируется'};
  const entity='id'in intent?state.accounts.find(a=>a.id===intent.id)??state.categories.find(c=>c.id===intent.id)??state.counterparties.find(p=>p.id===intent.id):null;
  const describe=(v:unknown,k:string)=>k==='name'?String(v):typeof v==='boolean'?(v?'Да':'Нет'):v===null?(k==='parentId'?'Корневая категория':'По умолчанию'):state.categories.find(c=>c.id===v)?.name??values[String(v)]??String(v);
  const changes='patch'in intent?Object.entries(intent.patch??{}).map(([k,v])=>(labels[k]??'Настройка')+': '+describe(v,k)).join('; '):'';
  void command?.begin(intent,title+(entity?' «'+entity.name+'»':'')+(changes?'. '+changes:''),confirm);
 }
 const terms=foldSearch(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
 const filtered=sections.filter(s=>{const words=foldSearch(s.title+' '+s.description+' '+s.keywords).split(/[^\p{L}\p{N}]+/u);return terms.every(term=>words.some(word=>word.startsWith(term)));});
 const suggestions=state.counterparties.filter(p=>p.state==='discovered'&&(!p.hasBankIdentity||(p.proposalCandidates?.length??0)>=2)),hiddenParties=state.counterparties.filter(p=>p.state==='ignored');
 const matchesParty=(p:FinanceState['counterparties'][number])=>foldSearch(p.name).includes(foldSearch(partyQuery.trim()))&&(partyType==='all'||p.isSelf===(partyType==='self'));
 function partyCard(p:FinanceState['counterparties'][number]){
  const proposal=p.state!=='registered';
  return <article key={p.id} className={styles.settingsRow}><div><strong>{p.name}</strong>{p.isSelf&&<small>Это я</small>}{proposal&&!!p.proposalCandidates?.length&&<small>Операций: {p.proposalCandidates.length}</small>}</div><div className={styles.cardActions}>
   <button className={common.button} disabled={disabled} onClick={()=>openEntity({kind:'counterparty',id:p.id})}>Изменить</button>
   {proposal&&<button className={common.primaryButton} disabled={disabled} onClick={()=>openEntity({kind:'counterparty',id:p.id,add:true})}>Добавить</button>}
   {p.state==='discovered'?<button className={common.button} disabled={disabled} onClick={()=>begin({kind:'counterparty',id:p.id,patch:{state:'ignored'}},'Скрыть предложение')}>Не предлагать снова</button>
    :<button className={common.dangerButton} disabled={disabled} onClick={()=>void command?.begin({kind:'delete_counterparty',id:p.id},'Удалить карточку контрагента «'+p.name+'»?',true)}>Удалить</button>}
  </div></article>;
 }
 function content(){switch(current.id){
 case 'accounts':return <SettingsAccounts commandState={commandState} onNavigationGuard={onNavigationGuard} state={state} disabled={disabled} command={command} openOperations={onOperations} openStructure={id=>setEditor({kind:'account',id})} openDeletion={id=>onDelete({kind:'account',id})}/>;
 case 'imports':return imports;
 case 'categories':return <div className={styles.settingsStack}>
  <CategoryTree actions={<button className={common.primaryButton} disabled={disabled} onClick={()=>openEntity({kind:'category'})}>Добавить категорию</button>} footer={<button className={common.linkButton} disabled={disabled} onClick={()=>begin({kind:'reset_categories',id:crypto.randomUUID()},'Категории по умолчанию',true)}>Категории по умолчанию</button>} onEdit={c=>openEntity({kind:'category',id:c.id})} disabled={disabled} categories={state.categories} renderItem={c=><article key={c.id} className={styles.settingsRow}><div><strong>{c.name}</strong>{c.hidden&&<small>Скрыта</small>}</div><div className={styles.cardActions}><button className={common.iconButton} disabled={disabled} aria-label={'Изменить категорию: '+c.name} onClick={()=>openEntity({kind:'category',id:c.id})}><Settings2 size={17}/></button></div></article>}/>

 </div>;
 case 'counterparties':return <div className={styles.settingsStack}>
  <div role="tablist" aria-label="Списки контрагентов" className={styles.partyTabs}>{(['saved','suggestions'] as const).map((tab,i)=><button type="button" role="tab" key={tab} id={'parties-tab-'+tab} aria-selected={partyTab===tab} aria-controls="parties-panel" tabIndex={partyTab===tab?0:-1} onClick={()=>setPartyTab(tab)} onKeyDown={e=>{const next=e.key==='Home'?'saved':e.key==='End'?'suggestions':['ArrowLeft','ArrowRight'].includes(e.key)?(i===0?'suggestions':'saved'):null;if(!next)return;e.preventDefault();setPartyTab(next);document.getElementById('parties-tab-'+next)?.focus();}}>{tab==='saved'?'Контрагенты':'Предложения'}</button>)}</div>
  <div className={styles.listToolbar}><SearchField aria-label="Поиск контрагентов" placeholder="Найти по имени" value={partyQuery} onValueChange={setPartyQuery}/><SelectField aria-label="Тип контрагента" value={partyType} onChange={e=>setPartyType(e.target.value)}><option value="all">Все типы</option><option value="self">Это я</option><option value="other">Другие</option></SelectField><button className={common.primaryButton} disabled={disabled} onClick={()=>openEntity({kind:'counterparty'})}>Добавить контрагента</button></div>
  <div role="tabpanel" id="parties-panel" aria-labelledby={'parties-tab-'+partyTab} className={styles.settingsStack}>{partyTab==='suggestions'?<>{suggestions.filter(matchesParty).map(partyCard)}{!suggestions.some(matchesParty)&&<p className={styles.emptyState}>Нет предложений по этим условиям.</p>}{hiddenParties.length>0&&<details><summary>Показать скрытые</summary>{hiddenParties.filter(matchesParty).map(partyCard)}</details>}</>:state.counterparties.some(p=>p.state==='registered'&&matchesParty(p))?<div className={styles.settingsList}>{state.counterparties.filter(p=>p.state==='registered'&&matchesParty(p)).map(partyCard)}</div>:<p className={styles.emptyState}>{partyQuery||partyType!=='all'?'Контрагенты не найдены.':'Сохранённых контрагентов пока нет.'}</p>}</div>
 </div>;
 case 'rules':return <SettingsRules state={state} command={command} commandState={commandState} disabled={disabled}/>;
 case 'budgets':return <ServerBudgets state={state} command={command} commandState={commandState} disabled={disabled} timezone={timezone} onAccessError={onAccessError} onOperations={onBudgetOperations}/>;
 case 'analytics':return <div className={styles.settingsStack}><section className={styles.settingsBox}><h3>Учёт кредитных платежей</h3><OperationField label="Общая модель учёта"><SelectField disabled={disabled||!state.loanMode} value={state.loanMode??''} onChange={e=>void command?.begin({kind:'analytics',value:e.target.value as 'cashflow'|'economic'},'Изменить учёт кредитных платежей',true)}>{!state.loanMode&&<option value="">Недоступно</option>}<option value="cashflow">Считать расходом весь платёж</option><option value="economic">Считать расходом только проценты, комиссии и страховку</option></SelectField></OperationField><p className={styles.muted}>Действует для счетов, у которых выбрана общая настройка. Для отдельного кредита модель можно задать в разделе «Счета».</p></section><section className={styles.settingsBox}><h3>Исключённые операции</h3><p className={styles.muted}>Они остаются в списке, но не входят в стандартные итоги.</p><div className={styles.cardActions}><button className={common.button} disabled={disabled} onClick={()=>onOperations(null,true)}>Показать исключённые</button><button className={common.button} disabled={disabled} onClick={()=>setPicker({kind:'exclude',revision:state.revision})}>Выбрать для исключения</button></div></section></div>;
 case 'interface':return <InterfaceSettings appearance={appearance} preferences={navigationPreferences} disabled={disabled} onAppearance={onAppearance} onPreferences={onNavigationPreferences}/>;
 case 'privacy':return <div className={styles.settingsStack}><section className={styles.settingsBox}><h3>Как обрабатываются данные</h3><div className={styles.cardActions}><a className={common.button} href="/privacy">Открыть политику</a></div></section><section className={styles.settingsBox}><h3>Безопасность аккаунта</h3><div className={styles.cardActions}><button className={common.button} disabled={disabled} onClick={onAccount}>Пароль и активные сеансы</button></div></section><section className={styles.settingsBox}><h3>Удаление данных</h3><p className={styles.muted}>Перед подтверждением покажем, что будет удалено. Финансовый сброс сохраняет аккаунт и оплаченный доступ.</p><div className={styles.cardActions}><button className={common.dangerButton} disabled={disabled} onClick={()=>onDelete({kind:'period'})}>Удалить за период</button><button className={common.dangerButton} disabled={disabled} onClick={()=>onDelete({kind:'reset'})}>Полный финансовый сброс</button></div></section></div>;
 case 'history':return <ServerHistory state={state} command={command} disabled={disabled} timezone={timezone} operationId={historyOperationId} onClearScope={onClearHistory} onAccessError={onAccessError}/>;
 }}
 return <section className={`${styles.settings} ${section?styles.detailOpen:''}`} aria-label="Настройки сайта"><aside className={styles.sidebar}><div className={styles.sidebarSearch}><SearchField placeholder="Поиск настроек" aria-label="Поиск настроек" value={query} onValueChange={setQuery}/></div><nav className={styles.menu} ref={menu} tabIndex={-1} aria-label="Подразделы настроек">{filtered.map(s=><button key={s.id} disabled={disabled} aria-current={current.id===s.id?'page':undefined} onClick={()=>navigate('#settings/'+s.id)}><s.icon size={19}/><span><strong>{s.title}</strong><small>{s.description}</small></span></button>)}</nav>{!filtered.length&&<p className={styles.noResults}>Ничего не найдено. Измените запрос.</p>}</aside><div className={styles.detail}><button className={`${common.button} ${styles.back}`} disabled={disabled} onClick={()=>{navigate('#settings');queueMicrotask(()=>menu.current?.focus());}}><ArrowLeft size={16}/>Все настройки</button><div className={styles.sectionHead}><div className={styles.sectionIcon}><current.icon size={20}/></div><div><h2 tabIndex={-1} ref={heading}>{current.title}</h2></div></div>{entity&&<SettingsEntityDialog key={'entity:'+entity.kind+(entity.id??'new')+(entity.add?':add':'')} editor={entity} state={state} command={command} commandState={commandState} disabled={disabled} close={()=>setEntity(null)} onStructure={(id,action)=>setEditor({kind:entity.kind,id,action})} onOperations={onPartyOperations} proposalSelectionRevision={proposalSelectionRevision} onProposalOperations={id=>setPicker({kind:'proposal',id,revision:state.revision})} onRule={id=>{setEntity(null);setOpenedPartyRule(id);}} onAddOperations={id=>setPicker({kind:'party',id,revision:state.revision})}/>}{openedPartyRule&&<RuleEditor id={openedPartyRule} state={state} command={command} commandState={commandState} disabled={disabled} close={()=>setOpenedPartyRule(null)}/>}{editor&&(editor.kind==='account'?<AccountStructure key={editor.id} state={state} command={command} commandState={commandState} disabled={disabled} id={editor.id} close={()=>setEditor(null)} onAccessError={onAccessError}/>:<SettingsStructure key={'structure:'+editor.kind+':'+editor.action+':'+editor.id} state={state} command={command} disabled={disabled} timezone={timezone} commandState={commandState} editor={{kind:editor.kind,id:editor.id,action:editor.action}} close={()=>setEditor(null)}/>)} {picker&&<SettingsOperationPicker title={picker.kind==='exclude'?'Исключить операции':proposalParty?'Операции · '+proposalParty.name:'Добавить операции контрагента'} state={state} timezone={timezone} disabled={disabled} allowEmpty={!!proposalParty} allowedIds={proposalParty?proposalParty.proposalCandidates??noOperations:undefined}
 initialSelected={proposalParty?(proposalParty.proposalOperationIds??proposalParty.proposalCandidates?.slice(0,1000)??[]).filter(id=>proposalParty.proposalCandidates?.includes(id)):undefined}
 omit={picker.kind==='party'?state.operations.filter(o=>o.classification.counterparty.value===picker.id).map(o=>o.id):[]} onClose={()=>setPicker(null)} error={commandState.title===pickerTitle?commandState.error:undefined} onRetry={commandState.title===pickerTitle&&commandState.phase==='retry'&&!commandState.preview?()=>void command?.retry():undefined} onApply={ids=>{if(proposalParty){void command?.begin({kind:'counterparty',id:proposalParty.id,patch:{proposalOperationIds:ids}},pickerTitle,false,state);return;}const intent={kind:'bulk_operations' as const,operationIds:ids,patch:picker.kind==='exclude'?{analyticsOverride:'exclude' as const}:{counterpartyId:picker.id!}};void command?.begin(intent,pickerTitle,true);}}/>}<div className={styles.settingsContent}>{content()}</div></div></section>;
}
