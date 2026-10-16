import { amountLiteral } from './task-literals.ts';
import { parseMoneyRange } from './money-literals.ts';
import { parseOperationsFilter } from '../../finance-core/src/operations.ts';

/** Ordinary from/to ranges include both endpoints. Explicit strict single
 * bounds still go through the existing integer-cent grammar. The frozen
 * historical parser is left unchanged. */
export function assistantAmountLiteral(expression: string, basis: string) {
  const text = expression.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim().replace(/[.?]$/u, '');
  if (!['absolute_operation', 'signed_operation'].includes(basis)) throw new TypeError('TASK_AMOUNT_BASIS_UNSUPPORTED');
  const range = /^(?:от|с) (.+) (?:до|по) (.+)$/u.exec(text.replace(/ включительно$/u, ''));
  try {
    if (!range) return amountLiteral(text, text, basis);
    const bounds = parseMoneyRange(range[1], range[2]);
    if (BigInt(bounds.from) > BigInt(bounds.through)) throw new TypeError('TASK_AMOUNT_EXPRESSION_CONFLICT');
    if (basis === 'absolute_operation' && (BigInt(bounds.from) < 0n || BigInt(bounds.through) < 0n)) throw new TypeError('TASK_AMOUNT_EXPRESSION_CONFLICT');
    return parseOperationsFilter({ amountBasis: basis, amountFrom: bounds.from, amountThrough: bounds.through });
  } catch (error) {
    if (error instanceof TypeError && error.message === 'TASK_AMOUNT_EXPRESSION_CONFLICT') throw error;
    throw new TypeError('TASK_AMOUNT_EXPRESSION_UNSUPPORTED');
  }
}
