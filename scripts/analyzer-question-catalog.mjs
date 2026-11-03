import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const catalogUrl=new URL('../docs/architecture/analyzer-acceptance/questions-v1.json',import.meta.url);
export const documentUrl=new URL('../docs/architecture/analyzer-acceptance/questions-v1.md',import.meta.url);
export const routes={read:'Расчёт по БД',change:'Предложение с подтверждением',device:'Команда устройства',editor:'Отдельный редактор',explain:'Финансовое объяснение',calculator:'Точный калькулятор',blocked_fresh:'Нет свежего источника',blocked_document:'Нет документного инструмента',clarify:'Нужно уточнение',refuse:'Запрет / перенаправление',unsupported:'Неподдержанное условие'};
export function validateQuestionCatalog(c){
 if(c?.version!=='cashneuro-question-catalog/1'||c.status!=='prepared_not_model_measured'||c.paidCalls!==0||c.primarySpecSha256!=='5255d758534e74c9329cb8437e8a862f4bf989999172903a862462294b4ce9c8'||!Array.isArray(c.groups)||!Array.isArray(c.cases)||c.cases.length<250||c.cases.length>1000)throw Error('QUESTION_CATALOG_INVALID');
 const groups=new Map(c.groups.map(g=>[g.id,g])),ids=new Set(),questions=new Set();
 if(groups.size!==c.groups.length||groups.size<18)throw Error('QUESTION_GROUPS_INVALID');
 for(const x of c.cases){
  if(!groups.has(x.group)||!new RegExp('^'+x.group+'-[0-9]{3}$').test(x.id)||ids.has(x.id)||typeof x.question!=='string'||!x.question.trim()||x.question.length>2000||!Object.hasOwn(routes,x.route)||x.measurement!=='not_executed'||typeof x.expected!=='string'||!x.expected||typeof x.requires!=='string'||!x.requires)throw Error('QUESTION_CASE_INVALID');
  const signature=x.question.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/[.!?]$/u,'').trim()+'|'+x.requires;
  if(questions.has(signature))throw Error('QUESTION_CASE_DUPLICATE');
  ids.add(x.id);questions.add(signature);
 }
 for(const g of c.groups)if(!c.cases.some(x=>x.group===g.id)||!g.title||!g.rubric||!Array.isArray(g.spec)||!g.spec.length)throw Error('QUESTION_GROUP_INVALID');
 return c;
}
export function questionInputs(c){return validateQuestionCatalog(c).cases.map(x=>({question:x.question}));}
const cell=s=>String(s).replaceAll('|','\\|').replaceAll('\n',' ');
export function renderQuestionCatalog(raw){
 const c=validateQuestionCatalog(raw),counts=Object.fromEntries(Object.keys(routes).map(k=>[k,c.cases.filter(x=>x.route===k).length]));
 const out=['# Вопросы для приёмки Анализатора', '',c.cases.length+' вопросов · '+c.groups.length+' раздела · платных вызовов: 0.', '', '**Это подготовленный перечень, а не результат проверки живой модели. Все вопросы пока имеют статус not_executed.**', '', 'Кодовые, PostgreSQL и браузерные тесты функций учитываются отдельно. editor означает существующий отдельный редактор: свободная фраза не объявляется выполненной моделью. Неподключённый свежий источник/документный инструмент не считается продуктовым PASS.', '', '| Путь | Вопросов |','|---|---:|'];
 for(const [k,n]of Object.entries(counts))out.push('| '+routes[k]+' | '+n+' |');
 out.push('', '## Правила проверки','',...c.rules.map(x=>'- '+x),'', 'Исходный продуктовый PDF: SHA256 '+c.primarySpecSha256+'. Машиночитаемый перечень: [questions-v1.json](questions-v1.json).','');
 for(const g of c.groups){
  out.push('## '+g.title,'','Источник: PDF §§'+g.spec.join(', ')+'.','',g.rubric,'','Подготовка: '+g.context,'','| ID | Вопрос | Путь | Особое ожидание |','|---|---|---|---|');
  for(const x of c.cases.filter(x=>x.group===g.id))out.push('| '+x.id+' | '+cell(x.question)+' | '+routes[x.route]+' | '+(x.expected===g.rubric?'Критерии раздела':cell(x.expected))+' |');
  out.push('');
 }
 return out.join('\n');
}
export async function prepareQuestionCatalog(){
 const bytes=await readFile(catalogUrl),c=validateQuestionCatalog(JSON.parse(bytes));
 return {version:c.version,status:c.status,questionCount:c.cases.length,groups:c.groups.length,catalogSha256:createHash('sha256').update(bytes).digest('hex'),paidCalls:0,modelMeasuredCases:0,byRoute:Object.fromEntries(Object.keys(routes).map(k=>[k,c.cases.filter(x=>x.route===k).length])),cumulativeAdmission:'not_read_and_not_changed',liveRunner:false};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const action=process.argv[2]??'--prepare';
 if(process.argv.length>3||!['--prepare','--check','--write','--questions'].includes(action))throw Error('QUESTION_CATALOG_NO_LIVE_RUNNER');
 const c=validateQuestionCatalog(JSON.parse(await readFile(catalogUrl,'utf8')));
 if(action==='--write')await writeFile(documentUrl,renderQuestionCatalog(c));
 if(action==='--check'&&await readFile(documentUrl,'utf8')!==renderQuestionCatalog(c))throw Error('QUESTION_DOCUMENT_DRIFT');
 console.log(JSON.stringify(action==='--questions'?questionInputs(c):await prepareQuestionCatalog(),null,2));
}
