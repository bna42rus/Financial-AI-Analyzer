import {readFile,writeFile} from 'node:fs/promises';
import {analyzerLexicon,analyzerLexiconVersion} from '../packages/analyzer/src/next/lexicon.ts';

const document=new URL('../docs/architecture/analyzer-v2/lexicon.md',import.meta.url);
const sections={entity_role:'Роли названий',payment:'Типы кредитного платежа',calendar_month:'Месяцы',calendar_unit:'Единицы времени',time_relation:'Относительное время',metric:'Финансовые метрики',grouping:'Группировки',calculator:'Калькуляторы',format:'Формат результата',action:'Действия и контекст',financial_term:'Финансовые термины',statistic:'Статистика',operator:'Сравнение сумм',negation:'Отрицания и границы'};
const cell=value=>value.replaceAll('|','\\|');
let output=`# Словарь Анализатора

Версия: \`${analyzerLexiconVersion}\`. Понятий: ${analyzerLexicon.length}; тематических групп: ${Object.keys(sections).length}. Источник — \`packages/analyzer/src/next/lexicon.ts\`; документ создаётся командой \`node scripts/analyzer-lexicon.mjs --write\`.

Словарь сопоставляет термины внутри известного типа условия. Он не определяет финансовую релевантность, не выбирает инструмент и не даёт доступа к данным. Неоднозначный термин не выбирается автоматически. Суммы, числовые даты, годы, IDs и пользовательские названия не исправляются нечётким поиском.

Словоформы, сокращения и известные варианты перечислены явно. Допускается одна опечатка в целом слове от пяти букв; у типов кредитного платежа — до двух правок в слове от восьми букв, как в прежнем контекстном разборе. При нескольких кандидатах в этом радиусе выбора нет. Известное слово другой группы не переименовывается по опечатке: «карте» не становится «мартом». Короткие слова, отрицания и операторы не исправляются приблизительно. Июнь и июль не смешиваются.

Подключены к серверному разбору: роли названий, месяцы, относительные месяцы, тип платежа и обозначение графика/показа графика. Исправление роли вроде «счёта» возможно только рядом с точным полным названием из доступного каталога. Для опечатки в месяце нужен временной контекст: год, предлог периода или отдельная короткая реплика о месяце. Календарный месяц проверяется по исходному вопросу; год, дни и границы интервала сохраняются. График и выбор платежа требуют подходящего сохранённого расчёта.

Остальные метрики, калькуляторы, группировки, действия и термины пока образуют общий справочник; их наличие не означает реализации всех запросов. Словарь охватывает названия всех текущих метрик, группировок и калькуляторов закрытого реестра. Это не приёмка всех 240 задач. Prompt/schema текущего пилота не меняются, словарь не увеличивает модельный контекст и сам не вызывает ИИ.

Нельзя смешивать доход с любым поступлением, расход с любым списанием, денежный поток с остатком на дату, проценты в деньгах со ставкой. Неоднозначные общие слова не назначают метрику. Автоматическое приведение оператора суммы к противоположному или нестрогому варианту запрещено.
`;
for(const [family,title] of Object.entries(sections)){
 output+=`\n## ${title}\n\n| Код | Понятие | Словоформы и варианты |\n|---|---|---|\n`;
 for(const entry of analyzerLexicon.filter(e=>e.family===family))output+=`| \`${entry.key}\` | ${cell(entry.label)} | ${entry.forms.map(cell).join(', ')} |\n`;
}
const action=process.argv[2];
if(process.argv.length!==3||!['--write','--check'].includes(action))throw Error('LEXICON_ACTION_INVALID');
if(action==='--write')await writeFile(document,output);
else if(await readFile(document,'utf8')!==output)throw Error('LEXICON_DOCUMENT_DRIFT');
console.log(JSON.stringify({version:analyzerLexiconVersion,concepts:analyzerLexicon.length,families:Object.keys(sections).length,document:action==='--write'?'written':'checked'}));
