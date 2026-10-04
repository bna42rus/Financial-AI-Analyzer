import test from "node:test";
import assert from "node:assert/strict";
import {
  POSTGRES_BIGINT_MIN, POSTGRES_BIGINT_MAX, assertPersistableMinor,
  parsePersistedMinor, serializeMinor, sumMinor, assertComponentSum,
} from "../src/money.ts";

test("preserves cents beyond JavaScript safe integer range", () => {
  const value = parsePersistedMinor("9007199254740993");
  assert.equal(serializeMinor(value), "9007199254740993");
  assert.notEqual(serializeMinor(value), String(Number("9007199254740993")));
});

test("round trips signed persistent boundaries exactly", () => {
  for (const value of [POSTGRES_BIGINT_MIN, -1n, 0n, 1n, POSTGRES_BIGINT_MAX]) {
    assert.equal(parsePersistedMinor(serializeMinor(value)), value);
  }
});

test("rejects decimal floats, noncanonical strings and non-string API amounts", () => {
  for (const value of ["1.20", "1e3", " 1", "1 ", "+1", "01", "-0", "-01", "", "NaN", "Infinity", 1, 1.2, 1n, null, undefined]) {
    assert.throws(() => parsePersistedMinor(value), TypeError);
  }
});

test("rejects database range overflow on either side", () => {
  assert.throws(() => parsePersistedMinor("9223372036854775808"), RangeError);
  assert.throws(() => parsePersistedMinor("-9223372036854775809"), RangeError);
});

test("refund reduces a signed expense with exact cents", () => {
  assert.equal(sumMinor([-100_001n, 33_334n, 66_667n]), 0n);
});

test("aggregate is not truncated to database individual-amount range", () => {
  assert.equal(serializeMinor(sumMinor([POSTGRES_BIGINT_MAX, 1n])), "9223372036854775808");
});

test("accepts signed refund and own-transfer decompositions", () => {
  assertComponentSum(1_000_000n, [600_000n, 400_000n]);
  assertComponentSum(-1_500_000n, [-1_000_000n, -500_000n]);
  assertComponentSum(-100_000n, [-90_000n, -10_000n]);
});

test("rejects unsigned or mismatching components and empty active decomposition", () => {
  assert.throws(() => assertComponentSum(-100_000n, [90_000n, 10_000n]), RangeError);
  assert.throws(() => assertComponentSum(100_000n, [60_000n, 39_999n]), RangeError);
  assert.throws(() => assertComponentSum(0n, []), RangeError);
});

test("rejects unsafe runtime number inputs even without TypeScript compilation", () => {
  assert.throws(() => sumMinor([1 as unknown as bigint]), TypeError);
  assert.throws(() => serializeMinor(1 as unknown as bigint), TypeError);
  assert.throws(() => assertPersistableMinor(1 as unknown as bigint), TypeError);
});

test("signed decomposition and serialization invariants across deterministic cases", () => {
  for (let i = 1n; i <= 1000n; i++) {
    for (const sign of [-1n, 1n]) {
      const total = sign * (i * 997n + 1n);
      const first = total / 3n;
      const second = total / 7n;
      assertComponentSum(total, [first, second, total - first - second]);
      assert.equal(parsePersistedMinor(serializeMinor(total)), total);
    }
  }
});
