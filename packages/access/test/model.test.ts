import test from 'node:test';
import assert from 'node:assert/strict';
import { changeInvitation, claimPayment, createAccessRequest, durationLabel, emptyAccessStore, invitationStatus, moneyFromRubles, moneyLabel, receivedMinor, recordVerifiedEmail, requestStatus, reviewRequest } from '../src/model.ts';
import type { AccessStore, ReviewCommand, Tariff } from '../src/model.ts';
const created = '2026-10-07T09:00:00.000Z', verified = '2026-10-07T09:01:00.000Z', claimed = '2026-10-07T09:05:00.000Z', reviewed = '2026-10-07T10:00:00.000Z';
const tariff: Tariff = { id: 'month', name: 'Месяц', priceMinor: '99000', duration: { kind: 'calendar_months', count: 1 }, aiQuota: 150, active: true, publicVisible: true, availableForNew: true };
const create = (t: Tariff = tariff) => createAccessRequest(emptyAccessStore(), { id: 'request-1', name: 'Пример', email: 'USER@example.test', tariff: t }, created);
const ready = () => claimPayment(recordVerifiedEmail(create(), 'request-1', verified), 'request-1', { name: 'Пример отправителя', bank: 'Банк А' }, claimed);
const command = (overrides: Partial<ReviewCommand> = {}): ReviewCommand => ({ actionId: 'action-1', requestId: 'request-1', expectedRevision: 2, actorId: 'example-admin', actualMinor: '99000', receivedAt: claimed, decision: 'confirm', reason: '', ...overrides });
test('tariff terms are snapshotted and unsuitable tariffs cannot create requests', () => {
  const t = structuredClone(tariff), store = create(t); t.priceMinor = '119000'; t.duration.count = 3;
  assert.equal(store.requests[0]!.tariff.priceMinor, '99000'); assert.equal(store.requests[0]!.tariff.duration.count, 1);
  for (const key of ['active', 'publicVisible', 'availableForNew'] as const) assert.throws(() => create({ ...tariff, [key]: false }));
});
test('duplicate normalized email continues the existing pending flow', () => {
  const store = create(); assert.equal(store.requests[0]!.email, 'user@example.test');
  assert.throws(() => createAccessRequest(store, { id: 'request-2', name: 'Пример', email: ' user@EXAMPLE.test ', tariff }, created), /незавершённая/);
});
test('unverified, expired and incomplete applications cannot claim payment', () => {
  assert.throws(() => claimPayment(create(), 'request-1', { name: 'Имя', bank: 'Банк' }, claimed));
  const store = recordVerifiedEmail(create(), 'request-1', verified);
  assert.throws(() => claimPayment(store, 'request-1', { name: '', bank: 'Банк' }, claimed));
  assert.throws(() => claimPayment(store, 'request-1', { name: 'Имя', bank: '' }, claimed));
  const end = '2026-10-10T09:00:00.000Z'; assert.equal(requestStatus(store.requests[0]!, end), 'expired');
  assert.throws(() => claimPayment(store, 'request-1', { name: 'Имя', bank: 'Банк' }, end));
});
test('a payment claim removes automatic expiry and grants no access itself', () => {
  const store = ready(); assert.equal(requestStatus(store.requests[0]!, '2027-01-01T00:00:00Z'), 'under_review');
  assert.equal(store.requests[0]!.claimedAt, claimed); assert.equal(store.purchases.length, 0); assert.equal(store.payments.length, 0);
});
test('confirmation records actual payment and prepares an unactivated purchase, without issuing a secret link', () => {
  const store = reviewRequest(ready(), command(), reviewed);
  assert.equal(store.payments[0]!.actualMinor, '99000'); assert.equal(store.payments[0]!.expectedMinor, '99000');
  assert.deepEqual(store.purchases[0]!.duration, { kind: 'calendar_months', count: 1 });
  assert.equal(store.requests[0]!.status, 'paid_not_activated'); assert.equal(store.invitations[0]!.delivery, 'not_connected');
  assert.equal(Object.hasOwn(store.invitations[0]!, 'token'), false); assert.equal(Object.hasOwn(store.purchases[0]!, 'accessEnd'), false);
});
test('double confirmation is idempotent and action-ID reuse with different data is rejected', () => {
  const c = command(), store = reviewRequest(ready(), c, reviewed);
  assert.equal(reviewRequest(store, c, '2026-10-07T11:00:00Z'), store);
  assert.equal(store.payments.length, 1); assert.equal(store.purchases.length, 1); assert.equal(store.audit.length, 1);
  assert.throws(() => reviewRequest(store, { ...c, actualMinor: '100000' }, reviewed), /другого действия/);
  assert.throws(() => reviewRequest(store, { ...c, actionId: 'action-2', expectedRevision: 3 }, reviewed));
});
test('a stale preview cannot confirm a later revision', () => {
  const store = reviewRequest(ready(), command({ actualMinor: '50000', decision: 'topup', reason: 'Нужна доплата' }), reviewed);
  assert.throws(() => reviewRequest(store, command({ actionId: 'next' }), reviewed), /изменилась/);
});
test('underpayment and overpayment require an explicit choice and reason', () => {
  for (const amount of ['50000', '120000']) {
    assert.throws(() => reviewRequest(ready(), command({ actualMinor: amount }), reviewed), /отличается/);
    assert.throws(() => reviewRequest(ready(), command({ actualMinor: amount, decision: 'accept_full' }), reviewed));
    const store = reviewRequest(ready(), command({ actualMinor: amount, decision: 'accept_full', reason: 'Согласовано за полный тариф' }), reviewed);
    assert.equal(store.purchases[0]!.duration.count, 1); assert.equal(store.purchases[0]!.actualMinor, amount);
  }
});
test('partial payments are separate records, summed exactly, with the original tariff preserved', () => {
  let store = reviewRequest(ready(), command({ actualMinor: '50001', decision: 'topup', reason: 'Запрошена доплата' }), reviewed);
  assert.equal(store.requests[0]!.status, 'needs_topup'); assert.equal(store.purchases.length, 0);
  store = reviewRequest(store, command({ actionId: 'payment-2', expectedRevision: 3, actualMinor: '48999' }), reviewed);
  assert.equal(store.payments.length, 2); assert.equal(receivedMinor(store, 'request-1'), '99000'); assert.equal(store.purchases.length, 1);
});
test('rejecting a paid claim records a required manual return without pretending to perform a refund', () => {
  const store = reviewRequest(ready(), command({ actualMinor: '50000', decision: 'reject', reason: 'Заявка отклонена, возврат вне сервиса' }), reviewed);
  assert.equal(store.requests[0]!.status, 'rejected'); assert.equal(store.payments[0]!.disposition, 'return_required'); assert.equal(store.purchases.length, 0);
});
test('custom duration is explicit and never a ratio of payment to price', () => {
  const store = reviewRequest(ready(), command({ actualMinor: '20000', decision: 'custom', customDays: 17, reason: 'Отдельно согласовано 17 дней' }), reviewed);
  assert.deepEqual(store.purchases[0]!.duration, { kind: 'days', count: 17 });
  assert.throws(() => reviewRequest(ready(), command({ decision: 'custom', customDays: 0, reason: 'Причина' }), reviewed));
});
test('invitation expiry/reissue does not charge again or discard the paid entitlement', () => {
  let store = reviewRequest(ready(), command(), reviewed); const first = store.invitations[0]!;
  const after = '2026-10-11T10:00:00.000Z'; assert.equal(invitationStatus(first, after), 'expired');
  store = changeInvitation(store, { actionId: 'reissue-1', invitationId: first.id, actorId: 'example-admin', decision: 'reissue', reason: 'Истекла прежняя ссылка' }, after);
  assert.equal(store.invitations.length, 2); assert.equal(store.invitations[0]!.state, 'expired'); assert.equal(store.purchases.length, 1); assert.equal(store.payments.length, 1);
  assert.equal(store.invitations[1]!.purchaseId, first.purchaseId);
});
test('invitation cancellation is audited and stale invitations cannot replace the latest one', () => {
  let store = reviewRequest(ready(), command(), reviewed); const first = store.invitations[0]!;
  const c = { actionId: 'cancel-1', invitationId: first.id, actorId: 'example-admin', decision: 'cancel' as const, reason: 'Ошибка в заявке' };
  store = changeInvitation(store, c, reviewed); assert.equal(changeInvitation(store, c, reviewed), store);
  assert.equal(store.invitations[0]!.state, 'cancelled'); assert.equal(store.purchases.length, 1);
  store = changeInvitation(store, { ...c, actionId: 'reissue', decision: 'reissue' }, reviewed);
  assert.equal(store.invitations[0]!.state, 'cancelled');
  assert.throws(() => changeInvitation(store, { ...c, actionId: 'stale', decision: 'reissue' }, reviewed));
});
test('money boundaries reject float syntax and preserve cents and bigint precision', () => {
  assert.equal(moneyFromRubles('990,01'), '99001'); assert.equal(moneyFromRubles('90071992547409.91'), '9007199254740991');
  assert.match(moneyLabel('9007199254740991'), /,91 ₽$/);
  for (const value of ['1e3', '-1', '1.001', 'NaN', '01', '', '92233720368547759']) assert.throws(() => moneyFromRubles(value));
});
test('zero received amount cannot be recorded as a paid purchase', () => {
  assert.throws(() => reviewRequest(ready(), command({ actualMinor: '0', decision: 'accept_full', reason: 'Причина' }), reviewed), /Нет полученной оплаты/);
});
test('domain records have no financial transactions, chats, passwords or bank identifiers', () => {
  const store: AccessStore = reviewRequest(ready(), command(), reviewed), keys = Object.keys(store);
  for (const key of ['transactions', 'chats', 'password', 'totpSecret', 'accountNumber', 'cardNumber']) assert.equal(keys.includes(key), false);
  assert.equal(durationLabel(store.purchases[0]!.duration), '1 календарный месяц');
});
