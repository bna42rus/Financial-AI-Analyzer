import {assertClosedSchema} from './closed-schema.ts';
import {safeText} from '../../privacy/src/text.ts';
import {categoryTargets} from '../../finance-core/src/catalog/generated/activity-v1.ts';
import {selectedCategoryDefinitions} from '../../finance-core/src/selected-categories.ts';
import type {FinanceActionKind} from './actions.ts';

const closed=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const enumeration=(values:readonly string[])=>({type:'string',enum:values});
const name={type:'string',minLength:1,maxLength:160},boolean={type:'boolean'};
export const assistantChangeSchema={anyOf:[
 closed({kind:enumeration(['account']),name,patch:closed({name,type:enumeration(['debit_card','credit_card','bank_account','loan','savings','deposit','other']),analyticsEnabled:boolean,defaultVisible:boolean,loanMode:enumeration(['cashflow','economic'])},[])}),
 closed({kind:enumeration(['category']),name,patch:closed({name,hidden:boolean},[])}),
 closed({kind:enumeration(['create_category']),name,role:enumeration(['expense','income','both']),parentName:name},['kind','name','role']),
 closed({kind:enumeration(['counterparty']),name,patch:closed({name,state:enumeration(['registered','ignored']),isSelf:boolean},[])}),
 closed({kind:enumeration(['create_counterparty']),name}),
 closed({kind:enumeration(['analytics']),loanMode:enumeration(['cashflow','economic'])}),
 closed({kind:enumeration(['rule']),name,enabled:boolean}),
 closed({kind:enumeration(['apply_rule']),name}),
 closed({kind:enumeration(['answer_operations']),patch:closed({categoryName:name,subcategoryName:name,counterpartyName:name,comment:{type:'string',maxLength:1000},inclusion:enumeration(['default','include','exclude']),reviewRequested:boolean,role:enumeration(['expense','income','neutral','unresolved'])},[])}),
 closed({kind:enumeration(['budget_limit']),name,amountRubles:{type:'string',minLength:1,maxLength:40},applyFrom:enumeration(['current','next'])}),
 closed({kind:enumeration(['add_catalog_categories']),keys:{type:'array',minItems:1,maxItems:6,uniqueItems:true,items:enumeration(selectedCategoryDefinitions.map(d=>d.key))}}),
 closed({kind:enumeration(['category_binding']),targetKey:enumeration(categoryTargets.map(t=>t.key)),categoryName:name,subcategoryName:name},['kind','targetKey','categoryName']),
]};
export type AssistantChange=
 |{kind:'account';name:string;patch:{name?:string;type?:'debit_card'|'credit_card'|'bank_account'|'loan'|'savings'|'deposit'|'other';analyticsEnabled?:boolean;defaultVisible?:boolean;loanMode?:'cashflow'|'economic'}}
 |{kind:'category';name:string;patch:{name?:string;hidden?:boolean}}
 |{kind:'create_category';name:string;role:'expense'|'income'|'both';parentName?:string}
 |{kind:'counterparty';name:string;patch:{name?:string;state?:'registered'|'ignored';isSelf?:boolean}}
 |{kind:'create_counterparty';name:string}
 |{kind:'analytics';loanMode:'cashflow'|'economic'}
 |{kind:'rule';name:string;enabled:boolean}|{kind:'apply_rule';name:string}
 |{kind:'answer_operations';patch:{categoryName?:string;subcategoryName?:string;counterpartyName?:string;comment?:string;inclusion?:'default'|'include'|'exclude';reviewRequested?:boolean;role?:'expense'|'income'|'neutral'|'unresolved'}}
 |{kind:'budget_limit';name:string;amountRubles:string;applyFrom:'current'|'next'}
 |{kind:'add_catalog_categories';keys:string[]}|{kind:'category_binding';targetKey:string;categoryName:string;subcategoryName?:string};
export type AssistantProposal={version:'cashneuro-change-proposal/1';intent:Record<string,unknown>&{kind:FinanceActionKind};title:string;description:string[];sourceAnswerId:string|null};
export type ChangeCatalog={accounts:{id:string;name:string}[];categories:{id:string;name:string;parentId:string|null;role:string;hidden?:boolean}[];counterparties:{id:string;name:string}[];rules:{id:string;name:string;enabled:boolean;priority:number;conditions:unknown;assignments:unknown}[];budgets:{id:string;name:string}[]};
export class ChangeError extends TypeError{readonly code:string;constructor(code:string){super(code);this.code=code;}}
export function parseAssistantChange(raw:unknown):AssistantChange{
 try{assertClosedSchema(raw,assistantChangeSchema);}catch{throw new ChangeError('ASSISTANT_CHANGE_INVALID');}
 const change=structuredClone(raw) as AssistantChange;
 if('patch'in change&&!Object.keys(change.patch).length)throw new ChangeError('ASSISTANT_CHANGE_INVALID');
 if(change.kind==='answer_operations'&&change.patch.subcategoryName!==undefined&&change.patch.categoryName===undefined)throw new ChangeError('ASSISTANT_CHANGE_INVALID');
 const check=(v:unknown)=>{if(typeof v==='string')safeText(v,1000);else if(v&&typeof v==='object')Object.values(v).forEach(check);};check(change);return change;
}
const fold=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/\s+/gu,' ').trim();
/** Only the authenticated owner's metadata may be supplied. This compiler
 * resolves names locally; no catalog, UUID or financial row goes to the model. */
export function compileAssistantChange(raw:unknown,catalog:ChangeCatalog,options:{newId:string;sourceAnswerId:string|null;operationIds?:string[];parseRubles:(value:string)=>string}):AssistantProposal{
 const c=parseAssistantChange(raw);
 const find=<T extends {id:string;name:string}>(rows:T[],name:string):T=>{const matches=rows.filter(r=>fold(r.name)===fold(name));if(matches.length!==1)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');return matches[0]!;};
 const category=(name:string,parentId:string|null)=>find(catalog.categories.filter(c=>!c.hidden&&c.parentId===parentId),name);
 const fixed=()=>{const ids=options.operationIds;if(!options.sourceAnswerId||!ids?.length||ids.length>1000||new Set(ids).size!==ids.length)throw new ChangeError('ASSISTANT_CHANGE_SCOPE_REQUIRED');return [...ids];};
 let intent:AssistantProposal['intent'],title:string,description:string[]=[];
 if(c.kind==='account'||c.kind==='category'||c.kind==='counterparty'){
  const rows=c.kind==='account'?catalog.accounts:c.kind==='category'?catalog.categories:catalog.counterparties,entity=find(rows,c.name);
  intent={kind:c.kind,id:entity.id,patch:c.patch};title='Изменить '+({account:'счёт',category:'категорию',counterparty:'контрагента'}[c.kind])+': '+entity.name;
  const labels:Record<string,string>={name:'Название',hidden:'Скрыта',type:'Тип счёта',analyticsEnabled:'В аналитике',defaultVisible:'По умолчанию',loanMode:'Модель кредита',state:'Статус контрагента',isSelf:'Это я'};
  const values:Record<string,string>={cashflow:'Денежный поток',economic:'Экономический смысл',registered:'Зарегистрирован',ignored:'Игнорируется',debit_card:'Дебетовая карта',credit_card:'Кредитная карта',bank_account:'Банковский счёт',loan:'Кредит',savings:'Накопительный счёт',deposit:'Вклад',other:'Другой'};
  description=Object.entries(c.patch).map(([k,v])=>labels[k]+': '+(typeof v==='boolean'?(v?'Да':'Нет'):k==='name'?String(v):values[String(v)]??String(v)));
 }else if(c.kind==='create_category'){
  const parent=c.parentName?category(c.parentName,null):null;
  if(parent&&parent.role!=='both'&&c.role!==parent.role)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
  if(catalog.categories.some(row=>row.parentId===(parent?.id??null)&&fold(row.name)===fold(c.name)))throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
  intent={kind:'category',id:options.newId,create:true,patch:{name:c.name,role:c.role,parentId:parent?.id??null,hidden:false}};title='Создать категорию «'+c.name+'»';description=[parent?'В категории «'+parent.name+'»':'Отдельная категория',({expense:'Расходы',income:'Доходы',both:'Расходы и доходы'})[c.role]];
 }else if(c.kind==='create_counterparty'){
  if(catalog.counterparties.some(row=>fold(row.name)===fold(c.name)))throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
  intent={kind:'counterparty',id:options.newId,create:true,patch:{name:c.name,state:'registered',isSelf:false}};title='Создать контрагента «'+c.name+'»';
 }else if(c.kind==='analytics'){
  intent={kind:'analytics',value:c.loanMode};title='Изменить общую модель учёта кредитов';description=[c.loanMode==='cashflow'?'Денежный поток':'Экономический смысл','Персональные настройки отдельных счетов сохраняют приоритет.'];
 }else if(c.kind==='rule'||c.kind==='apply_rule'){
  const rule=find(catalog.rules,c.name);
  if(c.kind==='rule'){intent={kind:'rule',id:rule.id,patch:{name:rule.name,enabled:c.enabled,priority:rule.priority,conditions:rule.conditions,assignments:rule.assignments}};title=(c.enabled?'Включить':'Выключить')+' правило «'+rule.name+'»';description=['Уже сохранённые операции останутся прежними.'];}
  else{const ids=fixed();intent={kind:'apply_rules',ruleId:rule.id,operationIds:ids};title='Применить правило «'+rule.name+'»';description=['Только фиксированная выборка последнего расчёта: '+ids.length+' операций.'];}
 }else if(c.kind==='answer_operations'){
  const ids=fixed(),patch:Record<string,unknown>={};
  if(c.patch.categoryName!==undefined){const root=category(c.patch.categoryName,null),leaf=c.patch.subcategoryName?category(c.patch.subcategoryName,root.id):null;patch.categoryId=root.id;patch.subcategoryId=leaf?.id??null;description.push('Категория: '+root.name+(leaf?' / '+leaf.name:''));}
  if(c.patch.counterpartyName!==undefined){const party=find(catalog.counterparties,c.patch.counterpartyName);patch.counterpartyId=party.id;description.push('Контрагент: '+party.name);}
  for(const k of ['comment','reviewRequested','role'] as const)if(k in c.patch)patch[k]=c.patch[k];
  if(c.patch.comment!==undefined)description.push('Комментарий: '+c.patch.comment);
  if(c.patch.role!==undefined)description.push('Финансовый смысл: '+({expense:'Расход',income:'Доход',neutral:'Нейтрально',unresolved:'Не определён'})[c.patch.role]);
  if(c.patch.reviewRequested!==undefined)description.push(c.patch.reviewRequested?'Попросить проверить':'Снять свою просьбу о проверке');
  if(c.patch.inclusion!==undefined){patch.analyticsOverride=c.patch.inclusion;description.push(({default:'По настройкам счёта',include:'Включить в аналитику',exclude:'Исключить из аналитики'})[c.patch.inclusion]);}
  intent=ids.length===1?{kind:'operation',id:ids[0],patch}:{kind:'bulk_operations',operationIds:ids,patch};title='Изменить операции последнего расчёта';description.unshift('Фиксированная выборка: '+ids.length+' операций. Новые совпадения не добавляются.');
 }else if(c.kind==='budget_limit'){
  const budget=find(catalog.budgets,c.name),minor=options.parseRubles(c.amountRubles);
  intent={kind:'set_budget_limit',id:budget.id,limitMinor:minor,applyFrom:c.applyFrom};title='Изменить лимит бюджета «'+budget.name+'»';description=[c.amountRubles+' ₽',c.applyFrom==='current'?'С текущего периода':'Со следующего периода'];
 }else if(c.kind==='add_catalog_categories'){
  intent={kind:c.kind,keys:c.keys};title='Добавить выбранные категории';description=selectedCategoryDefinitions.filter(d=>c.keys.includes(d.key)).map(d=>d.path.join(' / '));
 }else{
  const root=category(c.categoryName,null),leaf=c.subcategoryName?category(c.subcategoryName,root.id):null;
  intent={kind:'set_category_binding',targetKey:c.targetKey,categoryId:root.id,subcategoryId:leaf?.id??null};title='Настроить распознавание категории';description=[categoryTargets.find(t=>t.key===c.targetKey)!.path.join(' / ')+' → '+root.name+(leaf?' / '+leaf.name:''),'Сохранённые операции и личные правила не переписываются.'];
 }
 return {version:'cashneuro-change-proposal/1',intent,title,description,sourceAnswerId:['answer_operations','apply_rule'].includes(c.kind)?options.sourceAnswerId:null};
}
export const assistantChangeInstructions='propose_change: заполни change по закрытой схеме, context/changes не нужны. Объекты только по явно названному имени; UUID не выдумывай. Поддержаны счёт (название, тип, аналитика, видимость, модель кредита), создание/переименование/скрытие категории, создание/изменение контрагента, общая модель кредита, включение/выключение существующего правила, применение правила и правки операций ТОЛЬКО последнего успешного финансового расчёта, лимит существующего бюджета с явным current|next, шесть выбранных категорий, привязка смысловой цели к собственной категории. answer_operations допустим только при явной ссылке на операции последнего ответа; иначе сначала read с нужной выборкой. Не удаляй данные, не переноси смысл чужой части просьбы. Для массовой categoryName задай именно категорию, subcategoryName отдельно. Для неоднозначного имени/области/периода бюджета — clarification. Это предложение, никаких изменений автоматически. Безопасность, доступ, пароли, SQL, другие пользователи и обход подтверждения всегда unsupported.';
