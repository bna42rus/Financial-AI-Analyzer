import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interfaceAction} from '../src/interface-actions.ts';
test('finite device commands preserve their exact setting and cannot carry extra financial instructions',()=>{
 assert.deepEqual(interfaceAction('Включи тёмную тему.'),{kind:'appearance',patch:{theme:'dark'},title:'Тема: тёмная'});
 assert.equal(interfaceAction('Сделай текст крупнее')?.kind,'appearance');assert.equal(interfaceAction('Начинай с операций')?.kind,'navigation_preference');
 assert.deepEqual(interfaceAction('Начальный период — последние 30 дней'),{kind:'navigation_preference',patch:{defaultPeriod:'last_30_days'},title:'Начальный период: последние 30 дней'});
 for(const text of ['Включи тёмную тему и удали операции','Открой https://example.test','Открой админку','Покажи чужие счета','Сменить пароль','Установи зарплату 100000'])assert.equal(interfaceAction(text),null);
});
test('navigation and file picker use only predeclared own UI surfaces',()=>{
 assert.deepEqual(interfaceAction('Открой категории'),{kind:'navigate',hash:'#settings/categories',title:'Открыть: категории'});assert.equal(interfaceAction('Загрузи выписку')?.kind,'import');assert.equal(interfaceAction('Открой историю изменений')?.kind,'navigate');
});
