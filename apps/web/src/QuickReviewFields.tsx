import {useState} from 'react';
import type {ReactNode} from 'react';
import {SearchFilter} from './SearchFilter';
import {allowedOperationRoles,kinds} from '../../../packages/finance-core/src/model';
import type {Kind,Role} from '../../../packages/finance-core/src/model';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import {OperationField} from './OperationDialog';
import type {BulkIntent,FinanceState,OperationPatch} from './finance-client';
import {kindNames,roleNames} from './finance-client';
import common from './App.module.css';
import layout from './Settings.module.css';
import fields from './ServerOperation.module.css';

export function QuickReviewFields({op,state,similarIds,requireSimilarSelection,similarControls,disabled,ruleHint,onApply,onSkip,canSkip,onOpen}:{op:FinanceState['operations'][number];state:FinanceState;similarIds:string[];requireSimilarSelection:boolean;similarControls:ReactNode;disabled:boolean;ruleHint?:string;onApply:(draft:BulkIntent)=>void;onSkip:()=>void;canSkip:boolean;onOpen:()=>void}){
 const s=op.classification,reasons=op.reviewReasons,has=(...names:string[])=>names.some(n=>reasons.includes(n));
 const needKind=has('low_kind_confidence'),needRole=has('low_role_confidence','unresolved_role','unresolved_transfer')||s.role.value==='unresolved';
 const needCategory=has('low_category_confidence','category_not_defined','category_conflict')||(!s.category.value&&['expense','income'].includes(s.role.value));
 const [kind,setKind]=useState<Kind>(s.kind.value),[role,setRole]=useState<Role>(s.role.value),[cat,setCat]=useState(s.category.value??''),[sub,setSub]=useState(s.subcategory.value??''),[party,setParty]=useState(s.counterparty.value??''),[comment,setComment]=useState(op.comment),[remember,setRemember]=useState(false);
 const roles=allowedOperationRoles(kind,op.amountMinor).filter(r=>r!=='unresolved'),wantsCategory=role==='expense'||role==='income';
 const fits=(value:string)=>value==='both'||value===role;
 const categories=state.categories.filter(c=>!c.hidden||c.id===cat||c.id===sub),roots=categories.filter(c=>!c.parentId&&fits(c.role)),children=categories.filter(c=>!!c.parentId&&(!cat||c.parentId===cat)&&fits(c.role)&&roots.some(p=>p.id===c.parentId));
 const roleError=role!=='unresolved'&&!roles.includes(role)?'Смысл не подходит выбранному типу.':undefined;
 const patch:OperationPatch={};
 if((needKind||kind!==s.kind.value)&&kind!=='other')patch.kind=kind;
 if((needRole||role!==s.role.value)&&role!=='unresolved'&&!roleError)patch.role=role;
 if(wantsCategory&&cat&&roots.some(c=>c.id===cat)&&(needCategory||cat!==(s.category.value??'')||sub!==(s.subcategory.value??''))){patch.categoryId=cat;patch.subcategoryId=sub||null;}
 if(patch.role!==undefined&&(!wantsCategory||!!s.category.value&&!roots.some(c=>c.id===s.category.value))&&patch.categoryId===undefined){patch.categoryId=null;patch.subcategoryId=null;}
 if(party!==(s.counterparty.value??''))patch.counterpartyId=party||null;
 if(comment!==op.comment)patch.comment=safeText(sanitizeText(comment),1000);
 const roleConflict=patch.kind!==undefined&&!allowedOperationRoles(kind,op.amountMinor).includes(role);
 const repeatable=!!ruleHint&&Object.keys(patch).some(k=>['kind','role','categoryId','subcategoryId'].includes(k))&&Object.keys(patch).every(k=>['kind','role','categoryId','subcategoryId'].includes(k));
 const ready=Object.keys(patch).length>0&&!roleError&&!roleConflict&&(!remember||repeatable)&&(!requireSimilarSelection||similarIds.length>0)&&!disabled;
 const showCategories=wantsCategory&&(needCategory||needRole||cat!==s.category.value);
 const categoryFields=<>
  <OperationField label="Категория"><SearchFilter label="Выберите категорию" single fullWidth options={roots.map(c=>[c.id,c.name] as const)} value={cat?[cat]:[]} disabled={disabled} onChange={ids=>{setCat(ids[0]??'');setSub('');}}/></OperationField>
  {children.length>0&&<OperationField label="Подкатегория"><SearchFilter label="Подкатегория" single fullWidth options={[['','Без подкатегории'],...children.map(c=>[c.id,cat?c.name:(roots.find(r=>r.id===c.parentId)?.name??'')+' / '+c.name] as const)]} value={[sub]} disabled={disabled} onChange={ids=>{const id=ids[0]??'';setSub(id);const parent=children.find(c=>c.id===id)?.parentId;if(parent)setCat(parent);}}/></OperationField>}
 </>;
 const kindField=<OperationField label="Тип операции"><SearchFilter label="Тип операции" single fullWidth disabled={disabled} value={[kind]} options={kinds.map(k=>[k,kindNames[k]??k] as const)} onChange={([id])=>{if(id)setKind(id as Kind);}}/></OperationField>;
 const roleField=<OperationField label="Финансовый смысл" error={roleError||(roleConflict?'Укажите смысл для выбранного типа.':undefined)}><SearchFilter label="Финансовый смысл" single fullWidth disabled={disabled} value={[role]} options={[['unresolved','Не определено'],...(roleError?[[role,roleNames[role]??role] as const]:[]),...roles.map(r=>[r,roleNames[r]??r] as const)]} onChange={([id])=>{
  if(!id)return;const next=id as Role;setRole(next);const allowed=(value:string)=>categories.some(c=>c.id===value&&(c.role===next||c.role==='both'));if(cat&&!allowed(cat)){setCat('');setSub('');}else if(sub&&!allowed(sub))setSub('');
 }}/></OperationField>;
 return <form onSubmit={e=>{e.preventDefault();if(!ready)return;onApply({kind:'bulk_operations',operationIds:[op.id,...similarIds],patch,...(repeatable&&remember?{rememberRule:true}:{})});}}>
 <fieldset className={fields.form+' '+layout.reviewForm} disabled={disabled}>
  {needKind&&kindField}{(needRole||needKind)&&roleField}{showCategories&&categoryFields}
  {has('possible_duplicate','unlinked_refund','dependency_conflict','component_conflict','incomplete_credit_data','source_timezone_unknown','source_timezone_conflict','posted_timezone_unknown','posted_timezone_conflict')&&<button type="button" className={common.button} onClick={onOpen}>Открыть карточку для проверки</button>}
  <details><summary>Другие поля</summary><div className={fields.form}>{!needKind&&kindField}{!needRole&&!needKind&&roleField}{wantsCategory&&!showCategories&&categoryFields}
   <OperationField label="Контрагент"><SearchFilter label="Контрагент" single fullWidth disabled={disabled} value={[party]} onChange={([id])=>setParty(id??'')} options={[['','Без контрагента'],...state.counterparties.filter(p=>p.state==='registered'||p.id===party).map(p=>[p.id,p.name] as const)]}/></OperationField>
   <OperationField label="Комментарий"><input value={comment} maxLength={1000} onChange={e=>setComment(e.target.value)}/></OperationField>
   {has('user_requested_review')&&<button type="button" className={common.button} onClick={()=>onApply({kind:'bulk_operations',operationIds:[op.id],patch:{reviewRequested:false}})}>Снять свою отметку проверки</button>}
  </div></details>
  <div className={layout.reviewOptions}>
   <div className={layout.reviewOption}>
    <label><input type="checkbox" checked={remember} disabled={!ruleHint} onChange={e=>setRemember(e.target.checked)}/>Запомнить для будущих операций</label>
    {remember&&<p>{repeatable?ruleHint+'. Перед сохранением покажем правило.':'Выберите категорию, тип или финансовый смысл для правила.'}</p>}
   </div>
   <div className={layout.reviewOption}>{similarControls}</div>
  </div>
 </fieldset>
 <div className={layout.interfaceActions}><button type="button" className={common.button} disabled={disabled||!canSkip} onClick={onSkip}>Пропустить</button><button className={common.primaryButton} disabled={!ready}>Применить</button></div></form>;
}
