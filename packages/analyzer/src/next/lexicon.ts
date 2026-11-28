/** Versioned domain lexicon. Only typed terms are resolved, never relevance,
 * monetary values, years, IDs or user-created names. No network or model calls. */
export const analyzerLexiconVersion='cashneuro-analyzer-lexicon/1';
export type Lexeme={family:string;key:string;label:string;forms:readonly string[];canonical:string};
export const analyzerLexicon:readonly Lexeme[]=Object.freeze((
[
 {"family":"entity_role","key":"accounts","label":"Счёт","forms":["счёт","счёта","счёту","счёте","счётом","счета","счетов","счетам","счетами","счетах","счот"],"canonical":"счёт"},
 {"family":"entity_role","key":"categories","label":"Категория / подкатегория","forms":["категория","категории","категорию","категорией","категорий","категориям","категориями","категориях","подкатегория","подкатегории","подкатегорию","подкатегорией","подкатегорий","подкатегориям","подкатегориями","подкатегориях"],"canonical":"категория"},
 {"family":"entity_role","key":"counterparties","label":"Контрагент","forms":["контрагент","контрагента","контрагенту","контрагентом","контрагенте","контрагенты","контрагентов","контрагентам","контрагентами","контрагентах"],"canonical":"контрагент"},
 {"family":"entity_role","key":"merchant","label":"Магазин","forms":["магазин","магазина","магазину","магазином","магазине","магазины","магазинов","мерчант","мерчанта","магазинам","магазинами","магазинах"],"canonical":"магазин"},
 {"family":"entity_role","key":"operations","label":"Операция","forms":["операция","операции","операцию","операцией","операций","операциям","операциями","операциях","транзакция","транзакции","транзакцию"],"canonical":"операция"},
 {"family":"entity_role","key":"banks","label":"Банк","forms":["банк","банка","банку","банком","банке","банки","банков","банкам","банками","банках"],"canonical":"банк"},
 {"family":"payment","key":"annuity","label":"Аннуитетный платёж","forms":["аннуитетный","аннуитетная","аннуитетные","аннуитетного","аннуитетному","аннуитетным","аннуитетном","аннуитет","ануитетный","аннуитентный","аннуитетную","аннуитетных","аннуитетными"],"canonical":"аннуитетный"},
 {"family":"payment","key":"differentiated","label":"Дифференцированный платёж","forms":["дифференцированный","дифференцированная","дифференцированные","дифференцированного","дифференцированному","дифференцированным","дифференцированном","диференцированный","дифиренцированный","дифференцированную","дифференцированных","дифференцированными"],"canonical":"дифференцированный"},
 {"family":"calendar_month","key":"january","label":"Январь","forms":["январь","января","январе","январю","январём","янв","янв."],"canonical":"январь"},
 {"family":"calendar_month","key":"february","label":"Февраль","forms":["февраль","февраля","феврале","февралю","февралём","фев","февр","февр."],"canonical":"февраль"},
 {"family":"calendar_month","key":"march","label":"Март","forms":["март","марта","марте","марту","мартом","мар","мар."],"canonical":"март"},
 {"family":"calendar_month","key":"april","label":"Апрель","forms":["апрель","апреля","апреле","апрелю","апрелем","апр","апр."],"canonical":"апрель"},
 {"family":"calendar_month","key":"may","label":"Май","forms":["май","мая","мае","маю","маем"],"canonical":"май"},
 {"family":"calendar_month","key":"june","label":"Июнь","forms":["июнь","июня","июне","июню","июнем","июн","июн."],"canonical":"июнь"},
 {"family":"calendar_month","key":"july","label":"Июль","forms":["июль","июля","июле","июлю","июлем","июл","июл."],"canonical":"июль"},
 {"family":"calendar_month","key":"august","label":"Август","forms":["август","августа","августе","августу","августом","авг","авг."],"canonical":"август"},
 {"family":"calendar_month","key":"september","label":"Сентябрь","forms":["сентябрь","сентября","сентябре","сентябрю","сентябрём","сен","сент","сент."],"canonical":"сентябрь"},
 {"family":"calendar_month","key":"october","label":"Октябрь","forms":["октябрь","октября","октябре","октябрю","октябрём","окт","окт."],"canonical":"октябрь"},
 {"family":"calendar_month","key":"november","label":"Ноябрь","forms":["ноябрь","ноября","ноябре","ноябрю","ноябрём","ноя","нояб","нояб."],"canonical":"ноябрь"},
 {"family":"calendar_month","key":"december","label":"Декабрь","forms":["декабрь","декабря","декабре","декабрю","декабрём","дек","дек."],"canonical":"декабрь"},
 {"family":"calendar_unit","key":"day","label":"День","forms":["день","дня","дней","дню","днём","дне","сутки","суток"],"canonical":"день"},
 {"family":"calendar_unit","key":"week","label":"Неделя","forms":["неделя","недели","неделю","недель","неделе","неделей","нед."],"canonical":"неделя"},
 {"family":"calendar_unit","key":"month","label":"Месяц","forms":["месяц","месяца","месяцев","месяцу","месяце","месяцем","мес","мес."],"canonical":"месяц"},
 {"family":"calendar_unit","key":"quarter","label":"Квартал","forms":["квартал","квартала","кварталов","квартале","кв."],"canonical":"квартал"},
 {"family":"calendar_unit","key":"year","label":"Год","forms":["год","года","лет","году","годом","г."],"canonical":"год"},
 {"family":"time_relation","key":"previous","label":"Предыдущий","forms":["предыдущий","предыдущая","предыдущее","предыдущие","прошлый","прошлая","прошлое","прошлые","предыдущего","предыдущем","предыдущему","предыдущую","прошлого","прошлом","прошлому","прошлую"],"canonical":"предыдущий"},
 {"family":"time_relation","key":"current","label":"Текущий","forms":["текущий","текущая","текущее","текущие","этот","эта","это","эти","текущего","текущем","текущему","текущую","этом","этого","этому","эту"],"canonical":"текущий"},
 {"family":"time_relation","key":"next","label":"Следующий","forms":["следующий","следующая","следующее","следующие","будущий","будущая","будущее","следующего","следующем","следующему","следующую","будущего","будущем","будущему","будущую"],"canonical":"следующий"},
 {"family":"year_reference","key":"same","label":"Год выбранного предыдущего периода","forms":["того же года","том же году","в том же году","тот же год","за тот же год"],"canonical":"того же года"},
 {"family":"metric","key":"expenses","label":"Расходы","forms":["расходы","расходов","расходам","расходами","траты","трат","потратил","потратила","потрачено","расход","расхода","расходу","расходе","тратам","тратами"],"canonical":"расходы"},
 {"family":"metric","key":"gross_expenses","label":"Расходы до возвратов","forms":["расходы без вычета возвратов","расходы до возвратов"],"canonical":"расходы без вычета возвратов"},
 {"family":"metric","key":"income","label":"Доходы","forms":["доход","доходы","доходов","доходам","доходами","заработал","заработала","дохода","доходу","доходе"],"canonical":"доход"},
 {"family":"metric","key":"difference","label":"Разница доходов и расходов","forms":["разница доходов и расходов","доходы минус расходы"],"canonical":"разница доходов и расходов"},
 {"family":"metric","key":"refunds","label":"Возвраты","forms":["возврат","возвраты","возвратов","возвращено"],"canonical":"возврат"},
 {"family":"metric","key":"reimbursements","label":"Компенсации расходов","forms":["компенсация расходов","компенсации расходов","возмещение расходов","возмещения расходов"],"canonical":"компенсация расходов"},
 {"family":"metric","key":"expense_reductions","label":"Возвраты и компенсации","forms":["возвраты и компенсации","уменьшение расходов"],"canonical":"возвраты и компенсации"},
 {"family":"metric","key":"own_transfers","label":"Собственные исходящие переводы","forms":["исходящие собственные переводы","переводы между своими счетами"],"canonical":"исходящие собственные переводы"},
 {"family":"metric","key":"transfers","label":"Сальдо переводов","forms":["сальдо переводов","поступления минус списания по переводам"],"canonical":"сальдо переводов"},
 {"family":"metric","key":"transfers_in","label":"Входящие переводы","forms":["входящие переводы","поступления переводов"],"canonical":"входящие переводы"},
 {"family":"metric","key":"transfers_out","label":"Исходящие переводы","forms":["исходящие переводы","списания переводов"],"canonical":"исходящие переводы"},
 {"family":"metric","key":"loan_principal","label":"Погашение тела кредита","forms":["погашение тела кредита","погашение основного долга"],"canonical":"погашение тела кредита"},
 {"family":"metric","key":"loan_payments","label":"Все списания по кредиту","forms":["все списания по кредиту","выплаты по кредиту","кредитные платежи"],"canonical":"все списания по кредиту"},
 {"family":"metric","key":"loan_costs","label":"Затраты по кредиту","forms":["проценты комиссии и страховка по кредиту","затраты по кредиту"],"canonical":"проценты комиссии и страховка по кредиту"},
 {"family":"metric","key":"fees","label":"Комиссии","forms":["комиссия","комиссии","комиссий","комиссиям"],"canonical":"комиссия"},
 {"family":"metric","key":"cash","label":"Движение наличных","forms":["движение наличных","внесения минус снятия наличных"],"canonical":"движение наличных"},
 {"family":"metric","key":"cash_in","label":"Внесение наличных","forms":["внесение наличных","внесения наличных","внёс наличные","внесла наличные"],"canonical":"внесение наличных"},
 {"family":"metric","key":"cash_out","label":"Снятие наличных","forms":["снятие наличных","снятия наличных","снял наличные","сняла наличные"],"canonical":"снятие наличных"},
 {"family":"metric","key":"operation_count","label":"Количество операций","forms":["количество операций","число операций","сколько операций"],"canonical":"количество операций"},
 {"family":"metric","key":"attention","label":"Требуют внимания","forms":["требуют внимания","требующие внимания","операции для проверки"],"canonical":"требуют внимания"},
 {"family":"metric","key":"budget","label":"Бюджеты","forms":["бюджет","бюджеты","бюджета","бюджетов"],"canonical":"бюджет"},
 {"family":"grouping","key":"time","label":"Время","forms":["по времени","по дням","по неделям","по месяцам","по годам"],"canonical":"по времени"},
 {"family":"grouping","key":"category","label":"Категория","forms":["по категориям","по категории"],"canonical":"по категориям"},
 {"family":"grouping","key":"subcategory","label":"Подкатегория","forms":["по подкатегориям","по подкатегории"],"canonical":"по подкатегориям"},
 {"family":"grouping","key":"account","label":"Счёт","forms":["по счетам","по счёту"],"canonical":"по счетам"},
 {"family":"grouping","key":"bank","label":"Банк","forms":["по банкам","по банку"],"canonical":"по банкам"},
 {"family":"grouping","key":"kind","label":"Тип операции","forms":["по типам операций","по типу операции"],"canonical":"по типам операций"},
 {"family":"grouping","key":"role","label":"Аналитическая роль","forms":["по аналитическим ролям","по ролям"],"canonical":"по аналитическим ролям"},
 {"family":"grouping","key":"counterparty","label":"Контрагент","forms":["по контрагентам","по контрагенту"],"canonical":"по контрагентам"},
 {"family":"grouping","key":"merchant","label":"Магазин","forms":["по магазинам","по магазину","по мерчантам"],"canonical":"по магазинам"},
 {"family":"grouping","key":"operation","label":"Операция","forms":["по операциям","отдельные операции"],"canonical":"по операциям"},
 {"family":"grouping","key":"none","label":"Без группировки","forms":["без группировки","общим итогом","одним итогом"],"canonical":"без группировки"},
 {"family":"calculator","key":"loan","label":"Кредит","forms":["кредит","кредита","кредиту","кредитом","кредите","кредиты","заём","займ","займа"],"canonical":"кредит"},
 {"family":"calculator","key":"deposit","label":"Вклад","forms":["вклад","вклада","вкладу","вкладом","вкладе","вклады","депозит","депозита"],"canonical":"вклад"},
 {"family":"calculator","key":"real_return","label":"Реальная доходность","forms":["реальная доходность","доходность после инфляции","с учётом инфляции"],"canonical":"реальная доходность"},
 {"family":"calculator","key":"investment_change","label":"Изменение инвестиций","forms":["изменение инвестиций","изменение стоимости инвестиции"],"canonical":"изменение инвестиций"},
 {"family":"calculator","key":"tax_by_rules","label":"Налог по заданным правилам","forms":["налог по заданным правилам","расчёт налога"],"canonical":"налог по заданным правилам"},
 {"family":"calculator","key":"insurance_case","label":"Страховой случай","forms":["страховой случай","расчёт страховой выплаты"],"canonical":"страховой случай"},
 {"family":"calculator","key":"savings_schedule","label":"График накоплений","forms":["график накоплений","накопления с пополнениями"],"canonical":"график накоплений"},
 {"family":"calculator","key":"loan_capacity","label":"Кредит под заданный платёж","forms":["кредит под заданный платёж","сумма кредита по платежу"],"canonical":"кредит под заданный платёж"},
 {"family":"calculator","key":"loan_term","label":"Срок кредита","forms":["срок кредита","срок погашения кредита"],"canonical":"срок кредита"},
 {"family":"calculator","key":"savings_goal","label":"Взнос к цели","forms":["взнос к цели","сколько откладывать к цели"],"canonical":"взнос к цели"},
 {"family":"calculator","key":"goal_term","label":"Срок достижения цели","forms":["срок достижения цели","когда накоплю"],"canonical":"срок достижения цели"},
 {"family":"calculator","key":"refinance","label":"Рефинансирование","forms":["рефинансирование","рефинансирования","рефинансировать"],"canonical":"рефинансирование"},
 {"family":"calculator","key":"affordability","label":"Доступность покупки","forms":["доступность покупки","могу ли позволить покупку"],"canonical":"доступность покупки"},
 {"family":"calculator","key":"reserve","label":"Резерв","forms":["резерв","резерва","резерву","подушка безопасности","финансовая подушка"],"canonical":"резерв"},
 {"family":"calculator","key":"percentage","label":"Процент от суммы","forms":["процент от суммы","процентное изменение"],"canonical":"процент от суммы"},
 {"family":"format","key":"chart","label":"График","forms":["график","графики","графика","графиков","графику","диаграмма","диаграммы","диаграмму","диаграмм","диаграмме","чарт","графике","графиками","графикам","графиках","диаграммой","диаграммами","диаграммах"],"canonical":"график"},
 {"family":"format","key":"table","label":"Таблица","forms":["таблица","таблицы","таблицу","таблицей","табличка","табличку","таблицам","таблицами","таблицах","таблице"],"canonical":"таблица"},
 {"family":"format","key":"number","label":"Число","forms":["число","числом","одним числом","только итог","только сумму"],"canonical":"число"},
 {"family":"format","key":"operations","label":"Операции","forms":["список операций","операции списком"],"canonical":"список операций"},
 {"family":"format","key":"text","label":"Объяснение","forms":["текстом","словами","кратко","подробно","объяснением"],"canonical":"текстом"},
 {"family":"action","key":"read","label":"Показать","forms":["покажи","покажите","выведи","выведите","отобрази","отобразите"],"canonical":"покажи"},
 {"family":"action","key":"calculate","label":"Посчитать","forms":["посчитай","посчитайте","рассчитай","рассчитайте","вычисли"],"canonical":"посчитай"},
 {"family":"action","key":"compare","label":"Сравнить","forms":["сравни","сравните","сопоставь","сопоставьте"],"canonical":"сравни"},
 {"family":"action","key":"explain","label":"Объяснить","forms":["объясни","объясните","что значит","что означает","что такое"],"canonical":"объясни"},
 {"family":"action","key":"clear","label":"Снять условие","forms":["убери условие","сними условие","очисти фильтр","убрать ограничение"],"canonical":"убери условие"},
 {"family":"action","key":"current","label":"Текущие условия","forms":["текущие условия","выбранные фильтры","условия на экране"],"canonical":"текущие условия"},
 {"family":"action","key":"keep","label":"Сохранить условия","forms":["оставь прежними","не меняй условия","не меняя условий","остальное сохрани"],"canonical":"оставь прежними"},
 {"family":"action","key":"new","label":"Новая задача","forms":["новая задача","новый вопрос","другая тема"],"canonical":"новая задача"},
 {"family":"action","key":"reference","label":"Предыдущий результат","forms":["предыдущий результат","прошлый расчёт","вернись к расчёту"],"canonical":"предыдущий результат"},
 {"family":"action","key":"propose","label":"Подготовить изменение","forms":["подготовь изменение","предложи правило","предложи бюджет"],"canonical":"подготовь изменение"},
 {"family":"financial_term","key":"card","label":"Банковская карта","forms":["карта","карты","карту","картой","карте","картам","картами","картах"],"canonical":"карта"},
 {"family":"financial_term","key":"principal","label":"Сумма / тело кредита","forms":["сумма кредита","тело кредита","основной долг"],"canonical":"сумма кредита"},
 {"family":"financial_term","key":"rate","label":"Годовая ставка","forms":["ставка","ставки","ставку","ставкой","годовая ставка","процентная ставка"],"canonical":"ставка"},
 {"family":"financial_term","key":"term","label":"Срок","forms":["срок","срока","сроку","сроком","сроке"],"canonical":"срок"},
 {"family":"financial_term","key":"payment","label":"Платёж","forms":["платёж","платежа","платежу","платежом","платежи","платежей","платежам","платежами","платежах"],"canonical":"платёж"},
 {"family":"financial_term","key":"interest","label":"Проценты в деньгах","forms":["проценты за весь срок","сумма процентов","процент"],"canonical":"проценты за весь срок"},
 {"family":"financial_term","key":"interest_rate","label":"Процентная доля","forms":["процент","процента","процентов","процентная доля"],"canonical":"процент"},
 {"family":"financial_term","key":"prepayment","label":"Досрочное погашение","forms":["досрочный платёж","досрочные платежи","досрочное погашение","досрочка"],"canonical":"досрочный платёж"},
 {"family":"financial_term","key":"capitalization","label":"Капитализация","forms":["капитализация","капитализации","капитализацию"],"canonical":"капитализация"},
 {"family":"financial_term","key":"transfer","label":"Перевод","forms":["перевод","переводы","переводов","переводам"],"canonical":"перевод"},
 {"family":"financial_term","key":"balance","label":"Остаток на дату","forms":["остаток","остатка","остатки","баланс","баланса"],"canonical":"остаток"},
 {"family":"financial_term","key":"inflow","label":"Поступление денег","forms":["поступление","поступления","зачисление","зачисления"],"canonical":"поступление"},
 {"family":"financial_term","key":"outflow","label":"Списание денег","forms":["списание","списания","списано"],"canonical":"списание"},
 {"family":"financial_term","key":"cash","label":"Наличные","forms":["наличные","наличных","наличными"],"canonical":"наличные"},
 {"family":"financial_term","key":"inflation","label":"Инфляция","forms":["инфляция","инфляции","инфляцию"],"canonical":"инфляция"},
 {"family":"financial_term","key":"insurance","label":"Страхование","forms":["страховка","страховки","страхование"],"canonical":"страховка"},
 {"family":"financial_term","key":"counterparty","label":"Сторона операции","forms":["контрагент","получатель","плательщик"],"canonical":"контрагент"},
 {"family":"financial_term","key":"profit","label":"Прибыль","forms":["прибыль","прибыли","прибылью"],"canonical":"прибыль"},
 {"family":"statistic","key":"sum","label":"Сумма","forms":["сумма","суммы","сумму","суммарно","всего"],"canonical":"сумма"},
 {"family":"statistic","key":"count","label":"Количество","forms":["количество","количества","число","числа"],"canonical":"количество"},
 {"family":"statistic","key":"mean","label":"Среднее","forms":["среднее","средняя","средний","в среднем"],"canonical":"среднее"},
 {"family":"statistic","key":"median","label":"Медиана","forms":["медиана","медианы","медиану","медианный"],"canonical":"медиана"},
 {"family":"statistic","key":"minimum","label":"Минимум","forms":["минимум","минимальный","наименьший","самый маленький"],"canonical":"минимум"},
 {"family":"statistic","key":"maximum","label":"Максимум","forms":["максимум","максимальный","наибольший","самый большой"],"canonical":"максимум"},
 {"family":"operator","key":"strict_lower","label":"Строго больше","forms":["строго больше","больше","свыше","более",">"],"canonical":"строго больше"},
 {"family":"operator","key":"strict_upper","label":"Строго меньше","forms":["строго меньше","меньше","менее","<"],"canonical":"строго меньше"},
 {"family":"operator","key":"inclusive_lower","label":"Не меньше","forms":["не меньше","не менее","от",">="],"canonical":"не меньше"},
 {"family":"operator","key":"inclusive_upper","label":"Не больше","forms":["не больше","не выше","не более","до включительно","<="],"canonical":"не больше"},
 {"family":"operator","key":"equal","label":"Равно","forms":["ровно","равно","="],"canonical":"ровно"},
 {"family":"operator","key":"range","label":"Диапазон","forms":["от до","между","в диапазоне"],"canonical":"от до"},
 {"family":"negation","key":"not","label":"Отрицание","forms":["не"],"canonical":"не"},
 {"family":"negation","key":"without","label":"Без","forms":["без"],"canonical":"без"},
 {"family":"negation","key":"except","label":"Кроме","forms":["кроме","исключая"],"canonical":"кроме"},
 {"family":"negation","key":"inclusive","label":"Включая границу","forms":["включительно"],"canonical":"включительно"}
] as Lexeme[]).map(entry=>Object.freeze({...entry,forms:Object.freeze(entry.forms)})));
const fold=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/\s+/gu,' ').trim();
function distance(a:string,b:string){
 const d=Array.from({length:a.length+1},()=>Array<number>(b.length+1).fill(0));
 for(let i=0;i<=a.length;i++)d[i]![0]=i;for(let j=0;j<=b.length;j++)d[0]![j]=j;
 for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){d[i]![j]=Math.min(d[i-1]![j]!+1,d[i]![j-1]!+1,d[i-1]![j-1]!+(a[i-1]===b[j-1]?0:1));if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i]![j]=Math.min(d[i]![j]!,d[i-2]![j-2]!+1);}return d[a.length]![b.length]!;
}
type IndexedLexeme={entry:Lexeme;words:readonly string[]};
const indexes=new Map<string,{entries:IndexedLexeme[];exact:Map<string,Lexeme[]>}>();
for(const entry of analyzerLexicon){
 let index=indexes.get(entry.family);if(!index){index={entries:[],exact:new Map()};indexes.set(entry.family,index);}
 const forms=[...new Set(entry.forms.map(fold))];
 index.entries.push({entry,words:forms.filter(f=>/^[\p{L}]{5,32}$/u.test(f))});
 for(const form of forms){const candidates=index.exact.get(form)??[];candidates.push(entry);index.exact.set(form,candidates);}
}
const reservedForms=new Set(analyzerLexicon.flatMap(e=>e.forms.map(fold)));
export type LexemeMatch={status:'known';key:string;canonical:string;label:string;match:'exact'|'typo';distance:number}|{status:'unknown'}|{status:'ambiguous';keys:string[]};
export function resolveLexeme(family:string,value:string,allowTypos=false):LexemeMatch{
 if(typeof value!=='string'||!value||value.length>160)return {status:'unknown'};
 const word=fold(value),index=indexes.get(family);if(!index)return {status:'unknown'};
 const found=(items:readonly Lexeme[],match:'exact'|'typo',edits=0):LexemeMatch=>items.length===1?{status:'known',key:items[0]!.key,canonical:items[0]!.canonical,label:items[0]!.label,match,distance:edits}:items.length?{status:'ambiguous',keys:items.map(e=>e.key).sort()}:{status:'unknown'};
 const exact=index.exact.get(word);if(exact)return found(exact,'exact');
 if(!allowTypos||reservedForms.has(word)||['operator','negation','year_reference'].includes(family)||!/^[\p{L}]{5,32}$/u.test(word)||/^(?:не|без)/u.test(word))return {status:'unknown'};
 const maximum=family==='payment'&&word.length>=8?2:1;
 const matches=index.entries.map(({entry,words})=>({entry,distance:Math.min(...words.filter(f=>Math.abs(f.length-word.length)<=maximum).map(f=>distance(word,f)))})).filter(m=>m.distance<=maximum);
 // Every candidate inside the allowed distance matters. Do not pick an
 // arbitrary closest term when two financial meanings are plausible.
 return found(matches.map(m=>m.entry),'typo',matches[0]?.distance??0);
}
