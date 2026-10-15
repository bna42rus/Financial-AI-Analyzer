import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodLiteral, amountLiteral } from '../src/task-literals.ts';

const period = (text: string, today = '2026-10-15') => periodLiteral(text, 'Сумма трат за ' + text + '?', today);
test('periods use the server clock, real calendar bounds and inclusive dates across year/leap transitions', () => {
  const cases: [string, string, string][] = [
    ['сентябре 2026 года', '2026-09-01', '2026-09-30'], ['февраль 2024', '2024-02-01', '2024-02-29'],
    ['феврале 2025', '2025-02-01', '2025-02-28'], ['сентябрь', '2026-09-01', '2026-09-30'],
    ['с 5 по 12 августа 2026 года включительно', '2026-08-05', '2026-08-12'],
    ['с 2026-08-05 по 2026-09-12', '2026-08-05', '2026-09-12'],
    ['вчера', '2026-10-14', '2026-10-14'], ['сегодня', '2026-10-15', '2026-10-15'],
    ['этот месяц', '2026-10-01', '2026-10-15'], ['прошлый месяц', '2026-09-01', '2026-09-30'],
    ['последние 7 дней', '2026-10-09', '2026-10-15'], ['последние 6 месяцев', '2026-04-15', '2026-10-15'],
    ['последние 6 полных месяцев', '2026-04-01', '2026-09-30'],
  ];
  for (const [text, from, through] of cases) assert.deepEqual(period(text), { from, through }, text);
  assert.deepEqual(period('прошлый месяц', '2026-01-01'), { from: '2025-12-01', through: '2025-12-31' });
  assert.deepEqual(period('вчера', '2024-03-01'), { from: '2024-02-29', through: '2024-02-29' });
  assert.deepEqual(period('последние 1 месяц', '2024-03-31'), { from: '2024-02-29', through: '2024-03-31' });
});

test('a period cannot be copied from a hidden selected period or invented from a non-period quote', () => {
  assert.throws(() => periodLiteral('2026-09-01', 'Теперь покажи отдельные операции.', '2026-10-15'), /TASK_EVIDENCE_MISSING/);
  for (const text of ['отдельные операции', '2025-02-29', 'с 20 по 10 августа 2026', 'последние 0 дней', 'сентябрь и октябрь', 'после зарплаты']) assert.throws(() => period(text), text);
});

test('money ranges, shared units/scales and compound cents convert exactly once on the server', () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ['от 1000 до 2500 рублей включительно', '100000', '250000'],
    ['от 40 до 90 тысяч рублей включительно', '4000000', '9000000'],
    ['от 10 до 90 копеек включительно', '10', '90'],
    ['от 1 рубля до 2 рублей включительно', '100', '200'],
    ['от 1,25 до 2,50 рубля включительно', '125', '250'],
    ['не выше 99 рублей 50 копеек', undefined, '9950'], ['ровно 0.01 ₽', '1', '1'],
    ['больше 1000 рублей', '100001', undefined], ['меньше 1000 рублей', undefined, '99999'],
    ['не менее 2 млн рублей', '200000000', undefined], ['до 2500 рублей включительно', undefined, '250000'],
    ['>= 9 007 199 254 740,99 ₽', '900719925474099', undefined],
  ];
  for (const [text, from, through] of cases) {
    const result = amountLiteral(text, 'Доходы по операциям ' + text + '.', 'absolute_operation');
    assert.deepEqual(result, { amountBasis: 'absolute_operation', ...(from === undefined ? {} : { amountFrom: from }), ...(through === undefined ? {} : { amountThrough: through }) }, text);
  }
  assert.deepEqual(amountLiteral('меньше -10 рублей', 'Операции меньше -10 рублей.', 'signed_operation'), { amountBasis: 'signed_operation', amountThrough: '-1001' });
});

test('unsupported bases, contradictory comparators, overflow, percentages and fabricated money fail closed', () => {
  assert.throws(() => amountLiteral('от 1000 рублей', 'Доходы от 10 рублей', 'absolute_operation'));
  for (const text of ['больше 10 рублей включительно', 'от 200 до 100 рублей включительно', 'до 100 рублей', 'больше 10%', 'меньше -10 рублей', 'от 999999999999999999999 рублей'])
    assert.throws(() => amountLiteral(text, text, 'absolute_operation'), text);
  assert.throws(() => amountLiteral('от 10 рублей', 'от 10 рублей', 'metric_part'), /TASK_AMOUNT_BASIS_UNSUPPORTED/);
});
