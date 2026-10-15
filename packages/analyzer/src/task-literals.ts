import { dateFact } from '../../finance-core/src/model.ts';
import { parseOperationsFilter } from '../../finance-core/src/operations.ts';
import type { OperationsFilter } from '../../finance-core/src/operations.ts';
import { parseMoneyLiteral, parseMoneyRange } from './money-literals.ts';

export const literalContractVersion = 'analyzer-task-literals/1';
const normalized = (s: string) => s.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/gu, ' ').trim();
export function questionQuote(value: unknown, question: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 2000 || !question.includes(value)) throw new TypeError('TASK_EVIDENCE_MISSING');
  return value;
}
const day = (v: unknown) => (dateFact({ precision: 'day', date: v }) as { date: string }).date;
const iso = (v: Date) => day(v.toISOString().slice(0, 10));
const plusDays = (v: string, n: number) => { const d = new Date(v + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
function monthPeriod(year: number, month: number) {
  const from = day(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`);
  const end = new Date(from + 'T00:00:00Z'); end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { from, through: iso(end) };
}
const monthForms = ['январ(?:ь|я|е)', 'феврал(?:ь|я|е)', 'март(?:а|е)?', 'апрел(?:ь|я|е)', 'ма(?:й|я|е)', 'июн(?:ь|я|е)', 'июл(?:ь|я|е)', 'август(?:а|е)?', 'сентябр(?:ь|я|е)', 'октябр(?:ь|я|е)', 'ноябр(?:ь|я|е)', 'декабр(?:ь|я|е)'];
/** Closed literal grammar, not a keyword override of model relevance/intent.
 * Resolved dates can only come from this message's exact period expression. */
export function periodLiteral(literal: unknown, question: string, currentDate: string): Pick<OperationsFilter, 'from' | 'through'> {
  const quote = questionQuote(literal, question), today = day(currentDate), year = Number(today.slice(0, 4));
  const s = normalized(quote).replace(/^(?:за|в)\s+/u, '').replace(/[.?]$/u, '');
  if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) return { from: day(s), through: day(s) };
  let m = /^(?:с\s+)?(\d{4}-\d{2}-\d{2})\s+(?:по|до|—)\s+(\d{4}-\d{2}-\d{2})(?:\s+включительно)?$/u.exec(s);
  if (m) return parseOperationsFilter({ from: m[1], through: m[2] });
  if (s === 'сегодня') return { from: today, through: today };
  if (s === 'вчера') { const yesterday = plusDays(today, -1); return { from: yesterday, through: yesterday }; }
  if (/^(?:этот|текущий) месяц$/u.test(s)) return { from: today.slice(0, 7) + '-01', through: today };
  if (/^(?:прошлый|предыдущий) месяц$/u.test(s)) {
    const d = new Date(today.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1);
    return monthPeriod(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }
  m = /^(?:последние|последних) (\d{1,4}) (дней|дня|день|полных месяцев|полных месяца|месяцев|месяца|месяц)$/u.exec(s);
  if (m) {
    const count = Number(m[1]); if (!count || count > 3660 || !m[2]!.startsWith('д') && count > 120) throw new TypeError('TASK_PERIOD_UNSUPPORTED');
    if (m[2]!.startsWith('д')) return { from: plusDays(today, 1 - count), through: today };
    const d = new Date(today + 'T00:00:00Z'), original = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - count);
    if (m[2]!.startsWith('полных')) return { from: iso(d), through: plusDays(today.slice(0, 7) + '-01', -1) };
    const last = monthPeriod(d.getUTCFullYear(), d.getUTCMonth() + 1).through;
    d.setUTCDate(Math.min(original, Number(last.slice(-2)))); return { from: iso(d), through: today };
  }
  const month = monthForms.findIndex(form => new RegExp(`^(?:${form})(?: (\\d{4})(?: года| г\\.?)?)?$`, 'u').test(s));
  if (month !== -1) { const explicitYear = /(\d{4})/u.exec(s); return monthPeriod(explicitYear ? Number(explicitYear[1]) : year, month + 1); }
  for (let index = 0; index < monthForms.length; index++) {
    m = new RegExp(`^с (\\d{1,2}) по (\\d{1,2}) (${monthForms[index]}) (\\d{4})(?: года)?(?: включительно)?$`, 'u').exec(s);
    if (m) {
      const prefix = `${m[4]}-${String(index + 1).padStart(2, '0')}-`;
      return parseOperationsFilter({ from: prefix + m[1]!.padStart(2, '0'), through: prefix + m[2]!.padStart(2, '0') });
    }
  }
  throw new TypeError('TASK_PERIOD_UNSUPPORTED');
}
/** A threshold tests the whole effective operation, not a component or the
 * final metric total. Inclusive and strict bounds use exact integer cents. */
export function amountLiteral(literal: unknown, question: string, basis: unknown): OperationsFilter {
  const s = normalized(questionQuote(literal, question)).replace(/[.?]$/u, '');
  if (basis !== 'signed_operation' && basis !== 'absolute_operation') throw new TypeError('TASK_AMOUNT_BASIS_UNSUPPORTED');
  let from: bigint | undefined, through: bigint | undefined;
  const between = /^от (.+) до (.+) включительно$/u.exec(s);
  if (between) { const range = parseMoneyRange(between[1], between[2]); from = BigInt(range.from); through = BigInt(range.through); }
  else {
    const single = /^(не меньше|не менее|не выше|не больше|не более|больше|свыше|меньше|менее|ровно|равно|от|>=|<=|>|<|=)\s*(.+?)(?:\s+включительно)?$/u.exec(s);
    const inclusiveUpper = /^до (.+) включительно$/u.exec(s);
    if (inclusiveUpper) through = BigInt(parseMoneyLiteral(inclusiveUpper[1]));
    else {
      if (!single) throw new TypeError('TASK_AMOUNT_EXPRESSION_UNSUPPORTED');
      if (/включительно$/u.test(s) && ['больше', 'свыше', 'меньше', 'менее', '>', '<'].includes(single[1]!)) throw new TypeError('TASK_AMOUNT_EXPRESSION_CONFLICT');
      const n = BigInt(parseMoneyLiteral(single[2]));
      switch (single[1]) {
        case 'не меньше': case 'не менее': case 'от': case '>=': from = n; break;
        case 'больше': case 'свыше': case '>': from = n + 1n; break;
        case 'не выше': case 'не больше': case 'не более': case '<=': through = n; break;
        case 'меньше': case 'менее': case '<': through = n - 1n; break;
        default: from = n; through = n;
      }
    }
  }
  return parseOperationsFilter({ amountBasis: basis, ...(from === undefined ? {} : { amountFrom: from.toString() }), ...(through === undefined ? {} : { amountThrough: through.toString() }) });
}
