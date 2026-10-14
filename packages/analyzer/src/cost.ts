import { object } from '../../finance-core/src/model.ts';

// One billion integer accounting atoms per RUB. Banking amounts remain copecks;
// token costs need finer precision and must never use binary floating point.
export const rubAtoms = 1_000_000_000n;
export const baseMonthlyCost = 100n * rubAtoms;
export type TokenPrice = { version: string; currency: 'RUB'; inputRubPerMillion: string; outputRubPerMillion: string };
export type Usage = { inputTokens: number; outputTokens: number; modelVersion: string | null };
export type DispatchBound = { inputTokens: number; outputTokens: number; modelVersion: string };
export class CostError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }

export function rubAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})(?:\.\d{1,9})?$/.test(value)) throw new CostError('AI_PRICE_INVALID');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * rubAtoms + BigInt(fraction.padEnd(9, '0'));
}
export function tokenPrice(value: unknown): TokenPrice {
  const r = object(value, ['version', 'currency', 'inputRubPerMillion', 'outputRubPerMillion']);
  if (typeof r.version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(r.version) || r.currency !== 'RUB') throw new CostError('AI_PRICE_INVALID');
  for (const rate of [r.inputRubPerMillion, r.outputRubPerMillion]) {
    const parsed = rubAmount(rate);
    if (parsed <= 0n || parsed > 10_000n * rubAtoms) throw new CostError('AI_PRICE_INVALID');
  }
  return r as TokenPrice;
}
export function usageTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new CostError('AI_USAGE_INVALID');
  return value;
}
export function tokenCost(price: TokenPrice, input: number, output: number): bigint {
  const p = tokenPrice(price);
  const numerator = BigInt(usageTokens(input)) * rubAmount(p.inputRubPerMillion) + BigInt(usageTokens(output)) * rubAmount(p.outputRubPerMillion);
  // Conservative ceil at the accounting-atom boundary, never at each copeck.
  return (numerator + 999_999n) / 1_000_000n;
}
export function remainingCost(limit: bigint, settled: bigint, reserved: bigint): bigint {
  if ([limit, settled, reserved].some(v => v < 0n)) throw new CostError('AI_BALANCE_INVALID');
  return limit > settled + reserved ? limit - settled - reserved : 0n;
}
