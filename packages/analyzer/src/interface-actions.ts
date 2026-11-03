/** Finite device commands. No financial read, model call or backend authority. */
export const interfaceActionsVersion='cashneuro-interface-actions/1';
export type InterfaceAction=
 |{kind:'appearance';patch:{theme?:'system'|'light'|'dark';density?:'comfortable'|'compact';textSize?:'standard'|'large';motion?:'system'|'reduced'|'full'};title:string}
 |{kind:'navigation_preference';patch:{startScreen?:'overview'|'operations'|'analyzer'|'last';defaultPeriod?:'all'|'current_month'|'last_30_days'|'current_year'};title:string}
 |{kind:'navigate';hash:string;title:string}|{kind:'import';title:string};
const routes:Record<string,string>={'обзор':'#overview','операции':'#operations','анализатор':'#analyzer','настройки':'#settings','счета':'#settings/accounts','категории':'#settings/categories','правила':'#settings/rules','контрагентов':'#settings/counterparties','бюджеты':'#settings/budgets','историю изменений':'#settings/history','историю загрузок':'#settings/imports','настройки интерфейса':'#settings/interface','настройки аналитики':'#settings/analytics','конфиденциальность':'#settings/privacy'};
export function interfaceAction(question:string):InterfaceAction|null{
 const text=question.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/\s+/gu,' ').replace(/[.!]$/u,'').trim();
 let m=/^(?:включи|установи|поставь|сделай) (темную|светлую|системную) тему$/u.exec(text);
 if(m){const map={темную:'dark',светлую:'light',системную:'system'} as const,theme=map[m[1] as keyof typeof map];return {kind:'appearance',patch:{theme},title:'Тема: '+({dark:'тёмная',light:'светлая',system:'как на устройстве'})[theme]};}
 m=/^(?:сделай|установи) (?:текст|шрифт) (крупнее|крупным|большим|обычным|стандартным)$/u.exec(text);
 if(m){const textSize=['обычным','стандартным'].includes(m[1]!)?'standard':'large';return {kind:'appearance',patch:{textSize},title:textSize==='large'?'Крупный текст':'Обычный текст'};}
 m=/^(?:включи|установи|сделай) (компактный|комфортный) (?:режим|интерфейс)$/u.exec(text);
 if(m){const density=m[1]==='компактный'?'compact':'comfortable';return {kind:'appearance',patch:{density},title:density==='compact'?'Компактная плотность':'Комфортная плотность'};}
 if(['уменьши анимацию','отключи анимацию','включи анимацию','используй анимацию устройства'].includes(text))return {kind:'appearance',patch:{motion:text==='включи анимацию'?'full':text==='используй анимацию устройства'?'system':'reduced'},title:text==='включи анимацию'?'Обычная анимация':text==='используй анимацию устройства'?'Анимация как на устройстве':'Уменьшенное движение'};
 m=/^(?:открывай сайт с|начинай с) (обзора|операций|анализатора|последнего экрана)$/u.exec(text);
 if(m){const map={обзора:'overview',операций:'operations',анализатора:'analyzer','последнего экрана':'last'} as const;return {kind:'navigation_preference',patch:{startScreen:map[m[1] as keyof typeof map]},title:'Стартовый экран: '+m[1]};}
 m=/^начальный период (?:— |- |: )?(вся история|текущий месяц|последние 30 дней|текущий год)$/u.exec(text);
 if(m){const map={'вся история':'all','текущий месяц':'current_month','последние 30 дней':'last_30_days','текущий год':'current_year'} as const;return {kind:'navigation_preference',patch:{defaultPeriod:map[m[1] as keyof typeof map]},title:'Начальный период: '+m[1]};}
 m=/^(?:открой|покажи) (.+)$/u.exec(text);if(m&&routes[m[1]!])return {kind:'navigate',hash:routes[m[1]!]!,title:'Открыть: '+m[1]};
 if(['загрузи выписку','загрузить выписку','добавь выписку'].includes(text))return {kind:'import',title:'Загрузка выписок'};
 return null;
}
