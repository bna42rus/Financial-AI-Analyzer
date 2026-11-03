import {OverviewDialog} from './OverviewDialogs';
import {maskedOperationText} from './operation-display';
import overviewStyles from './Overview.module.css';
import {useMutationNotice} from './Notifications';
import {canSplitPurchase} from './operation-relations';
import {useEffect,useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import {kinds} from '../../../packages/finance-core/src/model';
import type {Account,Category,Facet,Link} from '../../../packages/finance-core/src/model';
import {sanitizeText} from '../../../packages/privacy/src/text';
import {api} from './server-client';
import {OperationFlow} from './operation-flow';
import {OperationLink,OperationParts} from './ServerRelations';
import {OperationCorrection} from './OperationCorrection';
import {OperationDialog,OperationField} from './OperationDialog';
import type {ComponentsIntent,LinkIntent} from './operation-relations';
import type {RelationEditor} from './ServerRelations';
import {componentNames,linkNames,linkStatusNames} from './operation-relations';
import type {OperationFlowState} from './operation-flow';
import {correctionPatch,displayBankDate,draftCorrections,displayRole,kindNames,rublesToMinor,reviewNames,roleNames} from './finance-client';
import type {FinanceDetail,FinancePreview,FinanceReceipt,OperationPatch} from './finance-client';
import {formatMoney} from './demo/overview';
import common from './App.module.css';
import drawer from './Operations.module.css';
import styles from './ServerOperation.module.css';
const originNames:Record<string,string>={user:'Вручную',personal_rule:'Персональное правило',deterministic_system_rule:'Правило системы',global_rule:'Общий справочник',ai:'AI',bank:'Банк'};
const patchNames:Record<string,string>={merchant:'Магазин',kind:'Тип операции',role:'Финансовый смысл',categoryId:'Категория',subcategoryId:'Подкатегория',counterpartyId:'Контрагент',comment:'Комментарий',analyticsOverride:'Участие в аналитике',amountMinor:'Сумма',operationDate:'Дата',postedDate:'Дата обработки',accountId:'Счёт'};
export function ServerOperation({onUndo,initial,accounts,sourceAccounts,categories,parties,rules,timezone,onSaved,onClose,onRelated,onAccessError,onHistory}:{onUndo:(id:string)=>void;initial:FinanceDetail;accounts:Account[];sourceAccounts:Account[];categories:Category[];parties:{id:string;name:string;state:string}[];rules:{id:string;name:string}[];timezone:string;onSaved:(detail:FinanceDetail)=>void;onClose:()=>void;onRelated:(id:string)=>void;onAccessError:(e:unknown)=>void;onHistory:()=>void}){
 const [state,setState]=useState<OperationFlowState>({detail:initial,phase:'idle',error:'',message:'',preview:null,conflict:null,undoActionId:null}),[merchant,setMerchant]=useState(initial.semantics.merchant.value),[comment,setComment]=useState(initial.comment),[correcting,setCorrecting]=useState(false),[draft,setDraft]=useState(()=>draftCorrections(initial)),[localError,setLocalError]=useState(''),[notice,setNotice]=useState('');
 const [fields,setFields]=useState<OperationPatch>({}),[discard,setDiscard]=useState<(()=>void)|null>(null);
 const [relationEditor,setRelationEditor]=useState<RelationEditor|null>(null);
 const [parts,setParts]=useState<ComponentsIntent>(),[links,setLinks]=useState<LinkIntent[]>([]),[submitted,setSubmitted]=useState<OperationPatch>({}),[checked,setChecked]=useState(false);
 const editorOpen=correcting||!!relationEditor;
 const flow=useRef<OperationFlow|null>(null),saved=useRef(onSaved),opener=useRef<HTMLElement|null>(null);saved.current=onSaved;
 useMutationNotice(state,id=>{if(flow.current)void flow.current.undo(id);else onUndo(id);});
 useEffect(()=>{const instance=new OperationFlow(initial,{request:(path,body)=>api<FinancePreview|FinanceReceipt>(path,body).catch(e=>{onAccessError(e);throw e;}),load:id=>api<FinanceDetail>('/finance/operation',{id}).catch(e=>{onAccessError(e);throw e;})},setState,detail=>saved.current(detail));flow.current=instance;return()=>{instance.dispose();if(flow.current===instance)flow.current=null;};},[initial.id]);
 const op=state.detail,disabled=state.phase!=='idle',blocked=['sending','retry'].includes(state.phase);
 const correctionsChanged=JSON.stringify(draft)!==JSON.stringify(draftCorrections(op));
 const dirty=Object.keys(fields).length>0||merchant!==op.semantics.merchant.value||comment!==op.comment||correctionsChanged||!!parts||links.length>0;
 function reset(){setFields({});setMerchant(op.semantics.merchant.value);setComment(op.comment);setDraft(draftCorrections(op));setCorrecting(false);setParts(undefined);setLinks([]);setSubmitted({});setChecked(false);setLocalError('');setNotice('');}
 useEffect(()=>{reset();setRelationEditor(null);},[op]);
 useEffect(()=>{if(!blocked&&!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[blocked,dirty]);
 function requestLeave(action=onClose){if(blocked)return;if(dirty)setDiscard(()=>action);else action();}
 const accountName=(id:string)=>sourceAccounts.find(a=>a.id===id)?.name??'Счёт',categoryName=(id:string|null)=>categories.find(c=>c.id===id)?.name??'Без категории',partyName=(id:string|null)=>parties.find(p=>p.id===id)?.name??'Не задан';
 const editingRole=fields.role??op.semantics.role.value,editingCategory=fields.categoryId===undefined?op.semantics.category.value:fields.categoryId,editingSubcategory=fields.subcategoryId===undefined?op.semantics.subcategory.value:fields.subcategoryId;
 const compatible=(c:Category)=>!['expense','income'].includes(editingRole)||c.role==='both'||c.role===editingRole;
 function edit(patch:OperationPatch){
  const base={kind:op.semantics.kind.value,role:op.semantics.role.value,categoryId:op.semantics.category.value,subcategoryId:op.semantics.subcategory.value,counterpartyId:op.semantics.counterparty.value,analyticsOverride:op.analyticsOverride};
  setLocalError('');setFields(f=>{const next={...f,...patch};for(const key of Object.keys(base) as (keyof typeof base)[])if(Object.hasOwn(patch,key)&&next[key]===base[key])delete next[key];return next;});
 }
 const effectiveAmount=rublesToMinor(draft.amount);
 const editorDetail:FinanceDetail={...op,semantics:{...op.semantics,kind:{...op.semantics.kind,value:(fields.kind??op.semantics.kind.value) as FinanceDetail['semantics']['kind']['value']},role:{...op.semantics.role,value:editingRole as FinanceDetail['semantics']['role']['value']},category:{...op.semantics.category,value:editingCategory},subcategory:{...op.semantics.subcategory,value:editingSubcategory}},projection:{...op.projection,amountMinor:effectiveAmount}};
 const canPurchase=canSplitPurchase(editorDetail)&&(!parts||parts.parts.every(p=>p.type==='other'&&p.role==='expense'&&BigInt(p.amountMinor)<0n));
 const existingLinks=[...op.links.filter(l=>!links.some(d=>d.id===l.id)),...links.map(l=>({...l.link,id:l.id,confidence:100,createdBy:'user' as const}))];
 const categoryError=editingCategory&&!categories.some(c=>c.id===editingCategory&&compatible(c))?'Выберите категорию, подходящую финансовому смыслу.':undefined;
 const subcategoryError=editingSubcategory&&!categories.some(c=>c.id===editingSubcategory&&c.parentId===editingCategory&&compatible(c))?'Выберите подкатегорию выбранной категории.':undefined;
 const effectiveParts=parts?.parts??op.components;
 const partsMismatch=effectiveParts.length>0&&(!!parts||correctionsChanged)&&effectiveParts.reduce((n,p)=>n+BigInt(p.amountMinor),0n)!==BigInt(effectiveAmount);
 const partError=(checked&&partsMismatch)||state.errorCode==='COMPONENT_SUM_CONFLICT'?'Сумма частей должна совпадать с суммой операции.':undefined;
 const linkError=state.errorCode&&['CAPACITY_CONFLICT','DEPENDENCY_CONFLICT','AMBIGUOUS_ENDPOINT','CYCLIC_DEPENDENCY','VERIFIED_FACET_CONFLICT','INCOMPATIBLE_RETURN','INCOMPATIBLE_REVERSAL','INCOMPATIBLE_TRANSFER','INCOMPATIBLE_REPAYMENT','CATEGORY_CONFLICT','LINK_CONFLICT','SOURCE_ALREADY_PAIRED','ALLOCATION_REFERENCE_CONFLICT'].includes(state.errorCode)&&links.length?state.error:undefined;
 function prepare(){
  setLocalError('');setChecked(true);
  if(categoryError||subcategoryError||partsMismatch)return;
  try{
   const patch={...fields},cleanMerchant=sanitizeText(merchant),cleanComment=sanitizeText(comment);
   if(cleanMerchant!==op.semantics.merchant.value)patch.merchant=cleanMerchant;
   if(cleanComment!==op.comment)patch.comment=cleanComment;
   if(correctionsChanged){const next=correctionPatch(op,draft);if(JSON.stringify(next.corrections)!==JSON.stringify(op.corrections))Object.assign(patch,next);}
   if(!Object.keys(patch).length&&!parts&&!links.length){setLocalError('Значения не изменились.');return;}
   if(cleanMerchant!==merchant||cleanComment!==comment)setNotice('Чувствительные реквизиты скрыты перед отправкой.');
   setSubmitted(patch);void flow.current?.saveCard(patch,parts,links);
  }catch(e){setLocalError(e instanceof Error?e.message:'Проверьте исправления.');}
 }
 function applyParts(next:ComponentsIntent){
  const existing=op.components,unchanged=next.parts.length===existing.length&&next.parts.every(p=>{const c=existing.find(c=>c.id===p.id);return c&&p.type===c.type&&p.amountMinor===c.amountMinor&&p.role===(c.role.userVerified?c.role.value:undefined)&&p.categoryId===(c.category.userVerified?c.category.value:undefined)&&p.subcategoryId===(c.subcategory.userVerified?c.subcategory.value:undefined);});
  setParts(unchanged?undefined:next);setRelationEditor(null);
 }
 function applyLink(next:LinkIntent){
  const old=op.links.find(l=>l.id===next.id);
  const unchanged=old&&Object.entries(next.link).every(([key,value])=>(old[key as keyof Link]??null)===(value??null));
  setLinks(list=>[...list.filter(l=>l.id!==next.id),...(unchanged?[]:[next])]);setRelationEditor(null);
 }
 const reasons=op.projection.reviewReasons,verification:OperationPatch={};
 if(reasons.includes('low_kind_confidence')&&!op.semantics.kind.userVerified)verification.kind=op.semantics.kind.value;
 if(reasons.includes('low_role_confidence')&&!op.semantics.role.userVerified&&op.semantics.role.value!=='unresolved')verification.role=op.semantics.role.value;
 if(reasons.includes('low_category_confidence')&&!op.semantics.category.userVerified&&op.semantics.category.value)verification.categoryId=op.semantics.category.value;
 function describe(key:string,value:unknown){if(key==='kind')return kindNames[String(value)];if(key==='role')return roleNames[String(value)];if(key==='categoryId'||key==='subcategoryId')return categoryName(value as string|null);if(key==='counterpartyId')return partyName(value as string|null);if(key==='accountId')return accountName(String(value));if(key==='amountMinor')return value===undefined?'Из выписки':formatMoney(String(value));if(key==='operationDate'||key==='postedDate')return value&&typeof value==='object'?displayBankDate(value as FinanceDetail['source']['operationDate'],timezone):'Из выписки';if(key==='analyticsOverride')return ({default:'По общему правилу',include:'Включить',exclude:'Исключить'} as Record<string,string>)[String(value)];return String(value??'Не задано');}
 function currentValue(key:string){const current=state.conflict!.current;if(key in current.semantics){return (current.semantics as unknown as Record<string,Facet<unknown>>)[key]!.value;}const map:Record<string,keyof typeof current.semantics>={categoryId:'category',subcategoryId:'subcategory',counterpartyId:'counterparty'};if(map[key])return current.semantics[map[key]!].value;if(key==='amountMinor')return current.projection.amountMinor;if(key==='operationDate')return current.projection.date;if(key==='accountId')return current.projection.accountId;if(key==='postedDate')return Object.hasOwn(current.corrections,'postedDate')?current.corrections.postedDate:current.source.postedDate;return (current as unknown as Record<string,unknown>)[key];}
 const attempt=state.conflict?.attempt.intent;
 const attemptFields:[string,unknown][]=attempt?.kind==='operation'?Object.entries(attempt.patch).flatMap<[string,unknown]>(([k,v])=>k==='corrections'?(['amountMinor','operationDate','postedDate','accountId'] as const).filter(key=>JSON.stringify(state.conflict!.attempt.baseline.corrections[key])!==JSON.stringify((v as FinanceDetail['corrections'])[key])).map<[string,unknown]>(key=>[key,(v as FinanceDetail['corrections'])[key]]):[[k,v]]):[];
 const included=op.projection.parts.every(p=>p.included);
 const previewTitle='Сохранить изменения?';
 const changedFields=Object.entries(submitted).flatMap<[string,unknown]>(([k,v])=>k==='corrections'?(['amountMinor','operationDate','accountId'] as const).filter(key=>JSON.stringify(op.corrections[key])!==JSON.stringify(submitted.corrections?.[key])).map<[string,unknown]>(key=>[key,submitted.corrections?.[key]]):[[k,v]]);
 const changes=state.preview?([['Расходы','netExpensesMinor'],['Доходы','incomeMinor'],['Не определено','unresolvedMinor'],['Нейтральные суммы','neutralMinor'],['Исключено','excludedMinor']] as const).flatMap(([label,key])=>{const before=state.preview!.impact.before[key],after=state.preview!.impact.after[key];return before===after?[]:[{label,before,after}];}):[];
 const newConflicts=state.preview?.impact.dependencyConflicts.filter(l=>state.preview?.impact.details?.kind==='operation_card'||op.linkStates.some(old=>old.id===l.id&&old.reason!==l.reason))??[];
 const linkDetail=(()=>{if(!parts&&effectiveAmount===op.projection.amountMinor)return editorDetail;
  const existing=parts?.parts;
  const current=existing?.length?existing.map(p=>({id:p.id,componentId:p.id,allocationId:null,amountMinor:p.amountMinor,role:p.role??op.components.find(c=>c.id===p.id)?.role.value??'unresolved' as const,categoryId:p.categoryId??null,subcategoryId:p.subcategoryId??null,basis:[],included:true})):existing||!op.components.length?[{id:op.id,componentId:null,allocationId:null,amountMinor:effectiveAmount,role:editorDetail.semantics.role.value,categoryId:editingCategory,subcategoryId:editingSubcategory,basis:[],included:true}]:op.projection.parts;
  return {...editorDetail,projection:{...editorDetail.projection,parts:current}};
 })();
 return <Dialog.Root open onOpenChange={opened=>{if(!opened)requestLeave();}}><Dialog.Portal><Dialog.Overlay className={common.overlay}/><Dialog.Content className={common.dialog+' '+styles.operationDialog} aria-describedby={undefined} onOpenAutoFocus={()=>{opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;}} onCloseAutoFocus={event=>{const target=opener.current?.isConnected?opener.current:document.getElementById('finance-content');if(target){event.preventDefault();target.focus({preventScroll:true});}}} onEscapeKeyDown={event=>{if(blocked)event.preventDefault();}} onInteractOutside={event=>{event.preventDefault();}}>
  <div className={common.dialogHead+' '+styles.operationHead}><Dialog.Title>Операция</Dialog.Title><button className={common.iconButton} disabled={blocked} aria-label="Закрыть операцию" onClick={()=>requestLeave()}><X size={20}/></button></div>
  <div className={styles.operationBody}>
  <h3 className={drawer.cardTitle}>{maskedOperationText(op.displayName?.compositeLabel||op.semantics.merchant.value||kindNames[op.semantics.kind.value]||'Операция')}</h3><strong className={drawer.cardAmount}>{formatMoney(op.projection.amountMinor)}</strong><p className={drawer.cardDate}>{displayBankDate(op.projection.date,timezone)} · {accountName(op.projection.accountId)}</p><p><strong>Описание из банка:</strong> {maskedOperationText(op.source.description||'Описание отсутствует в этой загрузке')}</p><div className={styles.tags}><span>{kindNames[op.semantics.kind.value]}</span><span>{displayRole(op.projection.analyticsRole,op.projection.amountMinor)}</span><span>{categoryName(op.semantics.category.value)}{op.semantics.subcategory.value?' / '+categoryName(op.semantics.subcategory.value):''}</span>{!included&&<span>{op.projection.parts.some(p=>p.included)?'Частично исключено из аналитики':'Исключено из аналитики'}</span>}</div>
  {op.projection.reviewReasons.length>0&&<section className={drawer.reviewNote} aria-label="Причины проверки"><div><p>Операция требует проверки.</p><ul>{op.projection.reviewReasons.map(reason=><li key={reason}>{reviewNames[reason]??'Нужно проверить связанные данные'}</li>)}</ul>{Object.keys(verification).length>0&&<button type="button" className={common.button} disabled={disabled||!!relationEditor} onClick={()=>{setFields(f=>({...verification,...f}));setNotice('Подтверждение будет записано при сохранении.');}}>Подтвердить проверенные поля</button>}</div></section>}{op.projection.unresolvedMinor!=='0'&&<p>Неопределённые части не включены в доходы или расходы.</p>}
  {state.message&&!['Изменение сохранено.','Изменение отменено.'].includes(state.message)&&<p role="status" className={styles.notice}>{state.message}</p>}{notice&&<p role="status" className={styles.notice}>{notice}</p>}{state.error&&!partError&&!linkError&&<p role="alert" className={common.error}>{state.error}</p>}{localError&&<p role="alert" className={common.error}>{localError}</p>}{state.phase==='sending'&&<p role="status">Проверяем и сохраняем изменение…</p>}
  {state.phase==='retry'&&<button className={common.primaryButton} onClick={()=>void flow.current?.retry()}>Повторить то же изменение</button>}{state.phase==='stale'&&<button className={common.button} onClick={()=>void flow.current?.reload()}>Обновить карточку</button>}
  {state.conflict&&<section className={styles.conflict} aria-label="Конфликт изменения"><h3>Данные изменились</h3>{attemptFields.length>0?<table><thead><tr><th>Поле</th><th>Сейчас</th><th>Ваша правка</th></tr></thead><tbody>{attemptFields.map(([key,value])=><tr key={key}><th>{patchNames[key]??key}</th><td>{describe(key,currentValue(key))}</td><td>{describe(key,value)}</td></tr>)}</tbody></table>:<p>{state.conflict.attempt.mode==='relation'?'Связь или распределение не применены. Обновите карточку и заново выберите части по текущим данным.':'Отмена ещё не применена. Сервер повторно проверит, можно ли безопасно отменить прежнее изменение.'}</p>}<div className={styles.actions}><button className={common.button} onClick={()=>flow.current?.useCurrent()}>Обновить карточку</button>{state.conflict.attempt.mode!=='relation'&&<button className={common.primaryButton} onClick={()=>void flow.current?.applyOwn()}>{attempt?.kind==='undo'?'Повторить отмену':'Применить мою правку поверх'}</button>}</div></section>}
  <fieldset className={styles.form} disabled={disabled||editorOpen}><legend>Поля операции</legend><label>Магазин<input aria-label="Магазин" maxLength={160} value={maskedOperationText(merchant)} onChange={e=>setMerchant(e.target.value)}/></label>
   <label>Тип операции<select aria-label="Тип операции" value={fields.kind??op.semantics.kind.value} onChange={e=>edit({kind:e.target.value})}>{kinds.map(k=><option value={k} key={k}>{kindNames[k]}</option>)}</select></label>
   <label>Финансовый смысл<select aria-label="Финансовый смысл" value={editingRole} onChange={e=>edit({role:e.target.value})}>{['expense','income','neutral','unresolved'].map(r=><option value={r} key={r}>{displayRole(r,op.projection.amountMinor)}</option>)}</select></label>
   <OperationField label="Категория" error={checked?categoryError:undefined}><select aria-label="Категория" value={editingCategory??''} onChange={e=>edit({categoryId:e.target.value||null,...(editingSubcategory?{subcategoryId:null}:{})})}><option value="">Без категории</option>{categories.filter(c=>c.parentId===null&&(compatible(c)||c.id===op.semantics.category.value)&&(!c.hidden||c.id===op.semantics.category.value)).map(c=><option key={c.id} value={c.id}>{c.name}{c.hidden?' (скрыта)':''}{!compatible(c)?' (несовместима)':''}</option>)}</select></OperationField>
   <OperationField label="Подкатегория" error={checked?subcategoryError:undefined}><select aria-label="Подкатегория" value={editingSubcategory??''} disabled={!editingCategory} onChange={e=>edit({subcategoryId:e.target.value||null})}><option value="">Без подкатегории</option>{categories.filter(c=>c.parentId===editingCategory&&compatible(c)&&(!c.hidden||c.id===op.semantics.subcategory.value)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></OperationField>
   <label>Контрагент<select aria-label="Контрагент" value={(fields.counterpartyId===undefined?op.semantics.counterparty.value:fields.counterpartyId)??''} onChange={e=>edit({counterpartyId:e.target.value||null})}><option value="">Не задан</option>{parties.filter(p=>p.state==='registered'||p.id===op.semantics.counterparty.value).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
   <label>Участие в аналитике<select aria-label="Участие в аналитике" value={fields.analyticsOverride??op.analyticsOverride} onChange={e=>edit({analyticsOverride:e.target.value as OperationPatch['analyticsOverride']})}><option value="default">По общему правилу</option><option value="include">Включить</option><option value="exclude">Исключить</option></select></label>
   <label>Комментарий<textarea aria-label="Комментарий" maxLength={1000} rows={3} value={maskedOperationText(comment)} onChange={e=>setComment(e.target.value)}/></label>
  </fieldset>

  <div className={styles.operationActions}>
   <button className={common.button} disabled={disabled||editorOpen} onClick={()=>setCorrecting(true)}>Изменить банковские значения</button>
   <button className={common.button} disabled={disabled||editorOpen||effectiveAmount==='0'&&!op.components.length&&!parts} onClick={()=>setRelationEditor({kind:'components',purchase:canPurchase})}>{canPurchase?'Разделить покупку по категориям':'Разделить операцию на части'}</button>
   <button className={common.button} disabled={disabled||editorOpen||effectiveAmount==='0'} onClick={()=>setRelationEditor({kind:'link'})}>Связать с другой операцией</button>
  </div>
  {(parts||links.length>0||correctionsChanged)&&<p className={styles.pending}>В черновике: {[correctionsChanged&&'банковские значения',parts&&'распределение',links.length>0&&'связи'].filter(Boolean).join(', ')}.</p>}
  {partError&&<p className={styles.fieldError} role="alert">{partError}</p>}{linkError&&<p className={styles.fieldError} role="alert">{linkError}</p>}
  <details className={drawer.cardSection}><summary>Как определено</summary><dl className={styles.origins}>{(['kind','role','category','subcategory','merchant','counterparty'] as const).map(key=>{const f=op.semantics[key];return <div key={key}><dt>{({kind:'Тип',role:'Смысл',category:'Категория',subcategory:'Подкатегория',merchant:'Магазин',counterparty:'Контрагент'})[key]}</dt><dd>{originNames[f.source]} · {f.confidence}%{f.userVerified?' · Подтверждено':''}{f.ruleId?' · '+(rules.find(r=>r.id===f.ruleId)?.name??'Правило'):''}</dd></div>;})}</dl></details>
  {(op.projection.decompositionActive||op.projection.parts.some(p=>p.allocationId))&&<section className={drawer.cardSection} aria-label="Учёт частей операции"><h3>Как сумма учтена</h3><p>В итогах используются эти части, без повторного учёта целой операции.</p><ul className={styles.parts}>{op.projection.parts.map(p=><li key={p.id}><strong>{formatMoney(p.amountMinor)} · {displayRole(p.role,p.amountMinor)}</strong><span>{categoryName(p.categoryId)}{p.subcategoryId?' / '+categoryName(p.subcategoryId):''}{!p.included?' · Исключено из аналитики':''}{p.allocationId?' · По связи с другой операцией':''}</span></li>)}</ul></section>}
  {op.components.length>0&&<section className={drawer.cardSection}><h3>Части операции</h3><p>Итог составной операции определяется частями. Правка полей операции не меняет подтверждённые части.</p><ul className={styles.parts}>{op.components.map(c=>{const parts=op.projection.parts.filter(p=>p.componentId===c.id),roles=[...new Set(parts.filter(p=>p.included).map(p=>displayRole(p.role,p.amountMinor)))];return <li key={c.id}><span>{componentNames[c.type]} · {formatMoney(c.amountMinor)}</span><span>Заданный смысл: {displayRole(c.role.value,c.amountMinor)}. В расчёте: {roles.length?roles.join(', '):parts.length?'исключено из аналитики':'часть не участвует — проверьте состав операции'}.</span></li>;})}</ul></section>}
  {existingLinks.length>0&&<section className={drawer.cardSection}><h3>Связанные операции</h3><ul className={styles.parts}>{existingLinks.map(l=><li key={l.id}><span>{linkNames[l.kind]} · {linkStatusNames[l.status]} · {formatMoney(l.amountMinor)} · {links.some(d=>d.id===l.id)?'В черновике':op.linkStates.find(s=>s.id===l.id)?.active?'Участвует в расчётах':'Не участвует в расчётах'}</span>{op.linkStates.find(s=>s.id===l.id)?.reason&&<span>У связи конфликт. Проверьте части, сумму и финансовый смысл.</span>}<div className={styles.actions}><button className={common.button} disabled={disabled||editorOpen} onClick={()=>requestLeave(()=>onRelated(l.sourceId===op.id?l.targetId:l.sourceId))}>Открыть связанную операцию</button><button className={common.button} disabled={disabled||editorOpen} onClick={()=>setRelationEditor({kind:'link',link:l})}>Изменить связь</button></div></li>)}</ul></section>}
 </div><footer className={styles.operationFooter}><button className={styles.quietButton} disabled={disabled||editorOpen} onClick={()=>requestLeave(onHistory)}>История операции</button><button className={common.button+' '+styles.rightAction} disabled={!dirty||disabled||editorOpen} onClick={reset}>Сбросить</button><button className={common.primaryButton} disabled={!dirty||disabled||editorOpen} onClick={prepare}>Сохранить</button></footer>
 {correcting&&<OperationCorrection initial={draft} detail={op} accounts={accounts} onClose={()=>setCorrecting(false)} onApply={value=>{setDraft(value);setCorrecting(false);}}/>}
 {relationEditor?.kind==='components'&&<OperationParts detail={editorDetail} purchase={relationEditor.purchase} categories={categories} staged={parts} serverError={partError} onClose={()=>setRelationEditor(null)} onApply={applyParts}/>}
 {relationEditor?.kind==='link'&&<OperationLink detail={linkDetail} existing={relationEditor.link} serverError={linkError} serverErrorCode={state.errorCode} onClose={()=>setRelationEditor(null)} onApply={applyLink} onReload={()=>requestLeave(()=>void flow.current?.reload())} onAccessError={onAccessError}/>}
 {state.preview&&state.phase!=='retry'&&<OperationDialog compact title={previewTitle} onClose={()=>flow.current?.cancelPreview()} footer={<><button className={common.button} disabled={state.phase!=='preview'} onClick={()=>flow.current?.cancelPreview()}>Отмена</button><button className={common.primaryButton} disabled={state.phase!=='preview'} onClick={()=>void flow.current?.confirm()}>Подтвердить и сохранить</button></>}>
  <section className={styles.preview} aria-label="Последствия изменения">
   {(changedFields.length>0||parts||links.length>0)&&<dl>{changedFields.map(([key,value])=><div key={key}><dt>{patchNames[key]??key}</dt><dd>{describe(key,value)}</dd></div>)}{parts&&<div><dt>Распределение</dt><dd>{parts.parts.length?('Частей: '+parts.parts.length):'Целая операция'}</dd></div>}{links.map(l=><div key={l.id}><dt>{linkNames[l.link.kind]}</dt><dd>{formatMoney(l.link.amountMinor)} · {linkStatusNames[l.link.status]}</dd></div>)}</dl>}
   {changes.length>0&&<dl>{changes.map(({label,before,after})=><div key={label}><dt>{label}</dt><dd>{formatMoney(before)} → {formatMoney(after)}</dd></div>)}</dl>}
   {newConflicts.length>0&&<p>Связей, требующих проверки: {newConflicts.length}. Они не будут участвовать в расчётах.</p>}
  </section>
 </OperationDialog>}
 {discard&&<OverviewDialog compact title="Изменения не сохранены" description="Закрыть карточку без сохранения?" onClose={()=>setDiscard(null)}><div className={overviewStyles.controls}><button className={common.button} onClick={()=>setDiscard(null)}>Остаться</button><button className={common.primaryButton} onClick={()=>{const action=discard;setDiscard(null);reset();action();}}>Не сохранять</button></div></OverviewDialog>}
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
