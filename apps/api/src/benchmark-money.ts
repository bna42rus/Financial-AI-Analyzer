import { parsePersistedMinor } from '../../../packages/finance-core/src/money.ts';

const number = '[+-]?(?:\\d{1,3}(?: \\d{3})+|\\d+)(?:[.,]\\d{1,2})?';
const scale = '(?:тыс(?:яч[а-я]*)?\\.?|млн\\.?|миллион[а-я]*)';
const ruble = '(?:руб(?:ль|ля|лей)?\\.?|р\\.?|₽)';
const kopeck = '(?:коп(?:еек|ейк[а-я]*)?\\.?)';
const expression = `(${number})(?:\\s*(${scale}))?(?:\\s*(${ruble}|${kopeck}))?(?:\\s+(\\d{1,2})\\s*${kopeck})?`;
const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim();
/** Parse an exact quoted currency amount. Never round or use floating point. */
export function parseMoneyLiteral(value: unknown): string {
  if (typeof value !== 'string' || value.length > 160) throw new TypeError('INVALID_MONEY_LITERAL');
  const match = new RegExp(`^${expression}$`, 'u').exec(normalize(value));
  if (!match) throw new TypeError('INVALID_MONEY_LITERAL');
  const [whole, fraction = ''] = match[1]!.replace(/ /g, '').replace(',', '.').split('.');
  const sign = whole!.startsWith('-') ? -1n : 1n, integer = BigInt(whole!.replace(/^[+-]/, ''));
  const unit = match[3] ?? '', cents = match[4];
  let amount: bigint;
  if (unit.startsWith('коп')) {
    if (match[2] || fraction || cents !== undefined) throw new TypeError('INVALID_MONEY_LITERAL');
    amount = sign * integer;
  } else {
    if (cents !== undefined && (fraction || match[2] || !unit)) throw new TypeError('INVALID_MONEY_LITERAL');
    const multiplier = match[2] ? /^(?:млн|миллион)/u.test(match[2]) ? 1_000_000n : 1000n : 1n;
    amount = sign * (integer * 100n + BigInt(cents ?? (fraction.padEnd(2, '0') || '0'))) * multiplier;
  }
  const result = amount.toString(); parsePersistedMinor(result); return result;
}
/** Quotes must correspond to complete numeric expressions in the question.
 * A model cannot replace 1000 with 100000 or drop cents from a compound sum. */
export function parseQuotedMoney(value: unknown, question: string): string {
  const minor = parseMoneyLiteral(value), quote = normalize(value as string).replace(/\.$/u, ''), source = normalize(question);
  for (const match of source.matchAll(new RegExp(expression, 'gu'))) {
    const start = match.index!, end = start + match[0].length;
    const next = source[end] ?? '', decimalContinuation = /[.,]/u.test(next) && /\d/u.test(source[end + 1] ?? '');
    if (/[\p{L}\p{N}.,+\-]/u.test(source[start - 1] ?? '') || /[\p{L}\p{N}+\-%]/u.test(next) || decimalContinuation) continue;
    const candidate = normalize(match[0]).replace(/\.$/u, '');
    // Unit omission is allowed only when it preserves the exact value. This
    // accepts 1000 from "1000 рублей", but rejects 99 from "99 руб 50 коп".
    if (candidate !== quote && !(candidate.startsWith(quote) && /^\s/u.test(candidate.slice(quote.length)))) continue;
    try { if (parseMoneyLiteral(candidate) === minor) return minor; } catch { /* Unsupported precision/overflow fails closed. */ }
  }
  throw new TypeError('MONEY_NOT_GROUNDED');
}
