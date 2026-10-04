/** Exact integer minor-unit helpers. No floating point financial arithmetic. */
export const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n;
export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

function requireBigInt(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint") throw new TypeError("Money must be bigint");
}

/** Validate individual persisted amounts; aggregate sums may exceed this range. */
export function assertPersistableMinor(value: bigint): void {
  requireBigInt(value);
  if (value < POSTGRES_BIGINT_MIN || value > POSTGRES_BIGINT_MAX) {
    throw new RangeError("Amount exceeds PostgreSQL bigint range");
  }
}

/** Canonical decimal integer string at a bank-amount/API write boundary. */
export function parsePersistedMinor(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("Amount must be a canonical integer string");
  }
  const amount = BigInt(value);
  assertPersistableMinor(amount);
  return amount;
}

/** JSON-safe exact value. No Number conversion; also handles large aggregates. */
export function serializeMinor(value: bigint): string {
  requireBigInt(value);
  return value.toString();
}

export function sumMinor(values: readonly bigint[]): bigint {
  let result = 0n;
  for (const value of values) {
    requireBigInt(value);
    result += value;
  }
  return result;
}

/** Validate signed active decomposition. Roles/capacities belong to graph services. */
export function assertComponentSum(parent: bigint, components: readonly bigint[]): void {
  assertPersistableMinor(parent);
  if (components.length === 0) throw new RangeError("Active decomposition is empty");
  for (const component of components) assertPersistableMinor(component);
  if (sumMinor(components) !== parent) {
    throw new RangeError("Signed component sum differs from effective transaction amount");
  }
}
