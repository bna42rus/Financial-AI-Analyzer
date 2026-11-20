import type {Rule} from '../../finance-core/src/rules.ts';
import {kinds} from '../../finance-core/src/model.ts';
import {validateRule} from '../../finance-core/src/rules.ts';
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
 closed({kind:enumeration(['create_counterparty']),name,isSelf:boolean},['kind','name']),
 closed({kind:enumeration(['manage']),entity:enumeration(['category','counterparty','rule','budget']),action:enumeration(['delete','merge','move']),name,sourceNames:{type:'array',minItems:1,maxItems:30,uniqueItems:true,items:name},replacementName:{anyOf:[name,{type:'null'}]},parentName:{anyOf:[name,{type:'null'}]},role:enumeration(['expense','income','both'])},['kind','entity','action','name']),
 closed({kind:enumeration(['create_rule']),name,conditions:closed({merchantEquals:name,merchantContains:name,descriptionContains:name,accountName:name,counterpartyName:name,direction:enumeration(['in','out']),kind:enumeration(kinds)},[]),assignments:closed({categoryName:name,subcategoryName:name,counterpartyName:name,merchant:name,role:enumeration(['expense','income','neutral','unresolved']),kind:enumeration(kinds),analyticsOverride:enumeration(['default','include','exclude'])},[]),priority:{type:'integer',minimum:-10000,maximum:10000}},['kind','name','conditions','assignments']),
 closed({kind:enumeration(['analytics']),loanMode:enumeration(['cashflow','economic'])}),
 closed({kind:enumeration(['rule']),name,enabled:boolean}),
 closed({kind:enumeration(['apply_rule']),name}),
 closed({kind:enumeration(['answer_operations']),patch:closed({kind:enumeration(kinds),merchant:name,categoryName:name,subcategoryName:name,counterpartyName:name,comment:{type:'string',maxLength:1000},inclusion:enumeration(['default','include','exclude']),reviewRequested:boolean,role:enumeration(['expense','income','neutral','unresolved'])},[])}),
 closed({kind:enumeration(['create_budget']),name,amountRubles:{type:'string',minLength:1,maxLength:40},period:enumeration(['week','month','quarter','year']),basis:enumeration(['net','gross']),applyFrom:enumeration(['current','next']),categoryName:name,subcategoryName:name,accountName:name},['kind','name','amountRubles','period','basis']),
 closed({kind:enumeration(['budget_limit']),name,amountRubles:{type:'string',minLength:1,maxLength:40},applyFrom:enumeration(['current','next'])}),
 closed({kind:enumeration(['add_catalog_categories']),keys:{type:'array',minItems:1,maxItems:6,uniqueItems:true,items:enumeration(selectedCategoryDefinitions.map(d=>d.key))}}),
 closed({kind:enumeration(['category_binding']),targetKey:enumeration(categoryTargets.map(t=>t.key)),categoryName:name,subcategoryName:name},['kind','targetKey','categoryName']),
]};
const ruleSchema=(assistantChangeSchema.anyOf as any[]).find(s=>s.properties.kind.enum[0]==='create_rule');
(assistantChangeSchema.anyOf as any[]).push(closed({kind:enumeration(['remember_answer']),name,assignments:ruleSchema.properties.assignments}));
export type AssistantChange=
 |{kind:'account';name:string;patch:{name?:string;type?:'debit_card'|'credit_card'|'bank_account'|'loan'|'savings'|'deposit'|'other';analyticsEnabled?:boolean;defaultVisible?:boolean;loanMode?:'cashflow'|'economic'}}
 |{kind:'category';name:string;patch:{name?:string;hidden?:boolean}}
 |{kind:'create_category';name:string;role:'expense'|'income'|'both';parentName?:string}
 |{kind:'counterparty';name:string;patch:{name?:string;state?:'registered'|'ignored';isSelf?:boolean}}
 |{kind:'create_counterparty';name:string;isSelf?:boolean}
 |{kind:'manage';entity:'category'|'counterparty'|'rule'|'budget';action:'delete'|'merge'|'move';name:string;sourceNames?:string[];replacementName?:string|null;parentName?:string|null;role?:'expense'|'income'|'both'}
 |{kind:'create_rule';name:string;conditions:{merchantEquals?:string;merchantContains?:string;descriptionContains?:string;accountName?:string;counterpartyName?:string;direction?:'in'|'out';kind?:typeof kinds[number]};assignments:{categoryName?:string;subcategoryName?:string;counterpartyName?:string;merchant?:string;role?:'expense'|'income'|'neutral'|'unresolved';kind?:typeof kinds[number];analyticsOverride?:'default'|'include'|'exclude'};priority?:number}
 |{kind:'remember_answer';name:string;assignments:{categoryName?:string;subcategoryName?:string;counterpartyName?:string;merchant?:string;role?:'expense'|'income'|'neutral'|'unresolved';kind?:typeof kinds[number];analyticsOverride?:'default'|'include'|'exclude'}}
 |{kind:'analytics';loanMode:'cashflow'|'economic'}
 |{kind:'rule';name:string;enabled:boolean}|{kind:'apply_rule';name:string}
 |{kind:'answer_operations';patch:{kind?:typeof kinds[number];merchant?:string;categoryName?:string;subcategoryName?:string;counterpartyName?:string;comment?:string;inclusion?:'default'|'include'|'exclude';reviewRequested?:boolean;role?:'expense'|'income'|'neutral'|'unresolved'}}
 |{kind:'create_budget';name:string;amountRubles:string;period:'week'|'month'|'quarter'|'year';basis:'net'|'gross';applyFrom?:'current'|'next';categoryName?:string;subcategoryName?:string;accountName?:string}
 |{kind:'budget_limit';name:string;amountRubles:string;applyFrom:'current'|'next'}
 |{kind:'add_catalog_categories';keys:string[]}|{kind:'category_binding';targetKey:string;categoryName:string;subcategoryName?:string};
export type AssistantProposal={version:'cashneuro-change-proposal/1';intent:Record<string,unknown>&{kind:FinanceActionKind};title:string;description:string[];sourceAnswerId:string|null};
export type ChangeCatalog={accounts:{id:string;name:string}[];categories:{id:string;name:string;parentId:string|null;role:string;hidden?:boolean}[];counterparties:{id:string;name:string}[];rules:{id:string;name:string;enabled:boolean;priority:number;conditions:unknown;assignments:unknown}[];budgets:{id:string;name:string}[]};
export class ChangeError extends TypeError{readonly code:string;constructor(code:string){super(code);this.code=code;}}
export function parseAssistantChange(raw:unknown):AssistantChange{
 try{assertClosedSchema(raw,assistantChangeSchema);}catch{throw new ChangeError('ASSISTANT_CHANGE_INVALID');}
 const change=structuredClone(raw) as AssistantChange;
 if(change.kind==='manage'&&(change.action==='merge'&&(!change.sourceNames?.length||!['category','counterparty'].includes(change.entity))||change.action==='move'&&(change.entity!=='category'||!Object.hasOwn(change,'parentName'))||change.entity==='category'&&change.action==='delete'&&!Object.hasOwn(change,'replacementName')))throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
 if('patch'in change&&!Object.keys(change.patch).length)throw new ChangeError('ASSISTANT_CHANGE_INVALID');
 if(change.kind==='remember_answer'&&(!Object.keys(change.assignments).length||change.assignments.subcategoryName&&!change.assignments.categoryName||change.assignments.kind==='own_transfer'&&change.assignments.role!=='neutral'))throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
 if(change.kind==='manage'&&(change.sourceNames!==undefined&&change.action!=='merge'||Object.hasOwn(change,'replacementName')&&(change.entity!=='category'||change.action!=='delete')||Object.hasOwn(change,'parentName')&&(change.entity!=='category'||change.action!=='move')||change.role!==undefined&&(change.entity!=='category'||!['merge','move'].includes(change.action))))throw new ChangeError('ASSISTANT_CHANGE_INVALID');
 if(change.kind==='create_rule'&&(!Object.keys(change.conditions).length||!Object.keys(change.assignments).length||change.assignments.subcategoryName&&!change.assignments.categoryName))throw new ChangeError('ASSISTANT_CHANGE_INVALID');
 if(change.kind==='answer_operations'&&change.patch.subcategoryName!==undefined&&change.patch.categoryName===undefined)throw new ChangeError('ASSISTANT_CHANGE_INVALID');
 const check=(v:unknown)=>{if(typeof v==='string')safeText(v,1000);else if(v&&typeof v==='object')Object.values(v).forEach(check);};check(change);return change;
}
const fold=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/\s+/gu,' ').trim();
/** Only the authenticated owner's metadata may be supplied. This compiler
 * resolves names locally; no catalog, UUID or financial row goes to the model. */
export function compileAssistantChange(raw:unknown,catalog:ChangeCatalog,options:{newId:string;sourceAnswerId:string|null;operationIds?:string[];parseRubles:(value:string)=>string;timezone?:string;rememberConditions?:Rule['conditions']}):AssistantProposal{
 const c=parseAssistantChange(raw);
 const find=<T extends {id:string;name:string}>(rows:T[],name:string):T=>{const matches=rows.filter(r=>fold(r.name)===fold(name)||'parentId'in r&&r.parentId&&catalog.categories.some(p=>p.id===r.parentId&&fold(p.name+' / '+r.name)===fold(name)));if(matches.length!==1)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');return matches[0]!;};
 const category=(name:string,parentId:string|null)=>find(catalog.categories.filter(c=>!c.hidden&&c.parentId===parentId),name);
 const fixed=()=>{const ids=options.operationIds;if(!options.sourceAnswerId||!ids?.length||ids.length>1000||new Set(ids).size!==ids.length)throw new ChangeError('ASSISTANT_CHANGE_SCOPE_REQUIRED');return [...ids];};
 let intent:AssistantProposal['intent'],title:string,description:string[]=[];
 if(c.kind==='manage'){
  const rows=c.entity==='category'?catalog.categories:c.entity==='counterparty'?catalog.counterparties:c.entity==='rule'?catalog.rules:catalog.budgets,target=find(rows,c.name);title=({delete:'Удалить',merge:'Объединить',move:'Переместить'})[c.action]+' · '+c.name;
  if(c.action==='delete')intent=c.entity==='category'?{kind:'delete_category',id:target.id,replacementId:c.replacementName?find(catalog.categories,c.replacementName).id:null}:c.entity==='counterparty'?{kind:'delete_counterparty',id:target.id}:c.entity==='rule'?{kind:'delete_rule',id:target.id}:{kind:'delete_budget',id:target.id};
  else if(c.action==='merge'){const sourceIds=c.sourceNames!.map(n=>find(rows,n).id);if(sourceIds.includes(target.id)||new Set(sourceIds).size!==sourceIds.length)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');intent={kind:c.entity==='category'?'merge_categories':'merge_counterparties',id:target.id,sourceIds,...(c.entity==='category'&&c.role?{targetRole:c.role}:{})};}
  else{const current=find(catalog.categories,c.name),parent=c.parentName?category(c.parentName,null):null;intent={kind:'migrate_category',id:current.id,parentId:parent?.id??null,role:c.role??current.role};}
  description=['Будут показаны зависимости и затронутые операции. Изменение применяется целиком после подтверждения.',...(c.sourceNames?['Источники: '+c.sourceNames.join(', ')]:[]),...(c.entity==='category'&&c.action==='delete'?[c.replacementName?'Перенести назначения в «'+c.replacementName+'»':'Снять назначения удаляемой категории; операции сохранятся.']:[])];
 }else if(c.kind==='account'||c.kind==='category'||c.kind==='counterparty'){
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
  intent={kind:'counterparty',id:options.newId,create:true,patch:{name:c.name,state:'registered',isSelf:c.isSelf??false}};title='Создать контрагента «'+c.name+'»';
 }else if(c.kind==='create_rule'||c.kind==='remember_answer'){
  if(catalog.rules.some(r=>fold(r.name)===fold(c.name)))throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
  if(c.kind==='remember_answer'&&!options.rememberConditions)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
  const sourceConditions=c.kind==='create_rule'?c.conditions:{},conditions:Record<string,unknown>=c.kind==='remember_answer'?{...options.rememberConditions}:{},assignments:Record<string,unknown>={};
  for(const k of ['merchantEquals','merchantContains','descriptionContains','direction','kind'] as const)if(sourceConditions[k]!==undefined)conditions[k]=sourceConditions[k];
  if(sourceConditions.accountName)conditions.accountId=find(catalog.accounts,sourceConditions.accountName).id;
  if(sourceConditions.counterpartyName)conditions.counterpartyId=find(catalog.counterparties,sourceConditions.counterpartyName).id;
  for(const k of ['merchant','role','kind','analyticsOverride'] as const)if(c.assignments[k]!==undefined)assignments[k]=c.assignments[k];
  if(c.assignments.categoryName){const root=category(c.assignments.categoryName,null),leaf=c.assignments.subcategoryName?category(c.assignments.subcategoryName,root.id):null;assignments.categoryId=root.id;assignments.subcategoryId=leaf?.id??null;}
  if(c.assignments.counterpartyName)assignments.counterpartyId=find(catalog.counterparties,c.assignments.counterpartyName).id;
  const patch=validateRule({name:c.name,enabled:true,priority:c.kind==='create_rule'?c.priority??0:0,conditions,assignments});
  intent={kind:'rule',id:options.newId,create:true,patch};title='Создать правило «'+c.name+'»';
  description=[...(c.kind==='remember_answer'?['Устойчивое банковское соответствие берётся из выбранных операций на сервере; реквизиты не передаются модели.']:[]),'Правило будет действовать для будущих операций после подтверждения. Сохранённые операции не меняются; их применение запрашивается отдельно.','Условия объединены через «и»: '+Object.entries(sourceConditions).map(([k,v])=>({merchantEquals:'Магазин равен',merchantContains:'Магазин содержит',descriptionContains:'Описание содержит',accountName:'Счёт',counterpartyName:'Контрагент',direction:'Направление',kind:'Тип операции'}[k as keyof typeof sourceConditions]??k)+' — '+v).join('; '),'Назначить: '+Object.entries(c.assignments).map(([key,value])=>({categoryName:'Категория',subcategoryName:'Подкатегория',counterpartyName:'Контрагент',merchant:'Магазин',role:'Финансовый смысл',kind:'Тип',analyticsOverride:'Участие в аналитике'}[key as keyof typeof c.assignments]??key)+' — '+(({expense:'Расход',income:'Доход',neutral:'Нейтрально',unresolved:'Не определено',own_transfer:'Свой перевод',transfer_in:'Входящий перевод',transfer_out:'Исходящий перевод',include:'Включить',exclude:'Исключить',default:'По настройкам'} as Record<string,string>)[String(value)]??String(value))).join('; '),'Приоритет: '+patch.priority+'. Ручные решения имеют приоритет.'];
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
  for(const k of ['kind','merchant','comment','reviewRequested','role'] as const)if(k in c.patch)patch[k]=c.patch[k];
  if(c.patch.comment!==undefined)description.push('Комментарий: '+c.patch.comment);
  if(c.patch.role!==undefined)description.push('Финансовый смысл: '+({expense:'Расход',income:'Доход',neutral:'Нейтрально',unresolved:'Не определён'})[c.patch.role]);
  if(c.patch.reviewRequested!==undefined)description.push(c.patch.reviewRequested?'Попросить проверить':'Снять свою просьбу о проверке');
  if(c.patch.inclusion!==undefined){patch.analyticsOverride=c.patch.inclusion;description.push(({default:'По настройкам счёта',include:'Включить в аналитику',exclude:'Исключить из аналитики'})[c.patch.inclusion]);}
  intent=ids.length===1?{kind:'operation',id:ids[0],patch}:{kind:'bulk_operations',operationIds:ids,patch};title='Изменить операции последнего расчёта';description.unshift('Фиксированная выборка: '+ids.length+' операций. Новые совпадения не добавляются.');
 }else if(c.kind==='create_budget'){
  if(!options.timezone||catalog.budgets.some(b=>fold(b.name)===fold(c.name))||c.subcategoryName&&!c.categoryName)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
  const filter:Record<string,unknown>={};if(c.categoryName){const root=category(c.categoryName,null);filter.categoryIds=[root.id];if(c.subcategoryName)filter.subcategoryIds=[category(c.subcategoryName,root.id).id];}
  if(c.accountName)filter.accountIds=[find(catalog.accounts,c.accountName).id];
  intent={kind:'save_budget',id:options.newId,create:true,enabled:true,...(c.applyFrom?{applyFrom:c.applyFrom}:{}),name:c.name,limitMinor:options.parseRubles(c.amountRubles),definition:{filter,basis:c.basis,period:{kind:c.period},timezone:options.timezone}};title='Создать бюджет «'+c.name+'»';description=[c.amountRubles+' ₽',c.applyFrom==='next'?'Начиная со следующего периода':'Начиная с текущего периода',({week:'Неделя',month:'Месяц',quarter:'Квартал',year:'Год'})[c.period],c.basis==='net'?'За вычетом возвратов':'Без вычета возвратов','Часовой пояс: '+options.timezone,'Операции и существующие бюджеты не изменятся.'];
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
export const assistantChangeInstructions='propose_change: заполни change по закрытой схеме, context/changes не нужны. Объекты только по явно названному имени; UUID не выдумывай. Поддержаны счёт (название, тип, аналитика, видимость, модель кредита), создание/переименование/скрытие категории, создание/изменение контрагента, общая модель кредита, создание НОВОГО личного правила create_rule (непустые явно заданные conditions и assignments; merchantEquals/merchantContains/descriptionContains, счёт/контрагент по имени; подкатегория вместе с родителем), включение/выключение существующего правила, применение правила и правки операций ТОЛЬКО последнего успешного финансового расчёта, создание бюджета create_budget с явным периодом и net/gross базой, лимит существующего бюджета с явным current|next, шесть выбранных категорий, привязка смысловой цели к собственной категории. answer_operations допустим только при явной ссылке на операции последнего ответа; иначе сначала read с нужной выборкой. Не удаляй данные, не переноси смысл чужой части просьбы. Для массовой categoryName задай именно категорию, subcategoryName отдельно. Для неоднозначного имени/области/периода бюджета — clarification. create_rule действует только на будущие операции, историческое применение — отдельное предложение apply_rule на фиксированном ответе. Если просят оба, объясни две стадии и не объявляй историю изменённой. Это предложение, никаких изменений автоматически. Безопасность, доступ, пароли, SQL, другие пользователи и обход подтверждения всегда unsupported.';

/** Compile a bounded ordered batch against virtual, owned metadata. No writes.
 * Backend revalidates every child inside one ordinary preview/commit. */
export function compileAssistantBatch(changes:{change:AssistantChange;operationIds?:string[];rememberConditions?:Rule['conditions']}[],catalog:ChangeCatalog,options:{requestId:string;ids:string[];sourceAnswerId:string|null;parseRubles:(v:string)=>string;timezone?:string}):AssistantProposal{
 if(!changes.length||changes.length>5||options.ids.length!==changes.length)throw new ChangeError('ASSISTANT_CHANGE_INVALID');
 const draft=structuredClone(catalog),proposals:AssistantProposal[]=[];
 for(const [i,s]of changes.entries()){
  const p=compileAssistantChange(s.change,draft,{newId:options.ids[i]!,sourceAnswerId:options.sourceAnswerId,operationIds:s.operationIds,parseRubles:options.parseRubles,timezone:options.timezone,rememberConditions:s.rememberConditions});proposals.push(p);const v=p.intent as any;
  if(v.create&&v.kind==='category')draft.categories.push({id:v.id,...v.patch});
  if(v.create&&v.kind==='counterparty')draft.counterparties.push({id:v.id,name:v.patch.name});
  if(v.create&&v.kind==='rule')draft.rules.push({id:v.id,...v.patch});
  if(v.kind==='save_budget'&&v.create)draft.budgets.push({id:v.id,name:v.name});
 }
 return {version:'cashneuro-change-proposal/1',intent:{kind:'compound',id:options.requestId,items:proposals.map(p=>p.intent)},title:'Подтвердить связанные изменения',description:proposals.flatMap((p,i)=>[(i+1)+'. '+p.title,...p.description]),sourceAnswerId:options.sourceAnswerId};
}

export const manageInstructions='manage выполняет явно запрошенные изменения справочников: entity category/counterparty/rule/budget, action delete/merge/move. Для merge name — цель, sourceNames — источники. Для удаления категории ОБЯЗАТЕЛЬНО replacementName (имя замены или явно выбранный null — снять категории, сохранить операции). Для move категории ОБЯЗАТЕЛЬНО parentName (имя родителя или null — верхний уровень); роль сохраняется, если не указана явно. Не объединяй сущности по совпадению имён без прямой просьбы. Неоднозначную подкатегорию указывай полным путём Родитель / Подкатегория. Все изменения только через preview/commit/Undo. answer_operations также умеет kind и merchant. Свой перевод — own_transfer и role neutral по явному решению пользователя; суммы/имена/последние цифры сами по себе владение не доказывают.';

export const rememberInstructions='Запомнить выбранного получателя/свой перевод: change remember_answer, name правила и assignments, source из последнего read (для report обязательный fromStep). Сервер сам извлекает устойчивое банковское соответствие по полным приватным признакам; реквизиты/UUID не выдумывай и не передавай. Для own_transfer обязательно role neutral. Если в выборке разные получатели — нужна более узкая выборка. Это правило только для будущих операций; правка сохранённых выполняется отдельным answer_operations в том же report. Для явно общего магазина без ограничения счёта — create_rule с merchantEquals/merchantContains по явной просьбе.';
