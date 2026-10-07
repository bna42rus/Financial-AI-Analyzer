import { assertPersistableMinor, parsePersistedMinor } from '../../finance-core/src/money.ts';

/** Deterministic domain transitions. Not an authentication, database or delivery adapter. */
export type Duration = { kind: 'calendar_months' | 'days'; count: number };
export type Tariff = { id: string; name: string; duration: Duration; priceMinor: string; aiQuota: number; publicVisible: boolean; availableForNew: boolean; active: boolean };
export type RequestStatus = 'awaiting_email' | 'awaiting_payment' | 'under_review' | 'needs_topup' | 'paid_not_activated' | 'rejected';
export type AccessRequest = {
  id: string; revision: number; name: string; email: string; tariff: Tariff; status: RequestStatus;
  createdAt: string; expiresAt: string; verifiedAt: string | null; claimedAt: string | null;
  senderName: string; senderBank: string; decisionNote: string;
};
export type Payment = { id: string; requestId: string; expectedMinor: string; actualMinor: string; receivedAt: string; recordedAt: string; senderName: string; senderBank: string; method: 'manual_transfer'; disposition: 'recorded' | 'return_required'; actionId: string };
export type Purchase = { id: string; requestId: string; tariff: Tariff; duration: Duration; actualMinor: string; paidAt: string; state: 'paid_not_activated' };
export type Invitation = { id: string; requestId: string; purchaseId: string; email: string; createdAt: string; expiresAt: string; state: 'active' | 'expired' | 'cancelled' | 'superseded'; delivery: 'not_connected' };
export type AuditEntry = { id: string; requestId: string; actorId: string; at: string; action: 'payment_confirmed' | 'topup_requested' | 'request_rejected' | 'custom_period_granted' | 'invitation_cancelled' | 'invitation_reissued'; reason: string };
export type AccessStore = { requests: AccessRequest[]; payments: Payment[]; purchases: Purchase[]; invitations: Invitation[]; audit: AuditEntry[]; replay: Record<string, string> };
export type ReviewCommand = { actionId: string; requestId: string; expectedRevision: number; actorId: string; actualMinor: string; receivedAt: string; decision: 'confirm' | 'accept_full' | 'topup' | 'reject' | 'custom'; reason: string; customDays?: number };
const lifetime = 72 * 60 * 60 * 1000;
export const emptyAccessStore = (): AccessStore => ({ requests: [], payments: [], purchases: [], invitations: [], audit: [], replay: {} });
function fail(message: string): never { throw new Error(message); }
function time(value: string): number { const n = Date.parse(value); if (!Number.isFinite(n) || !/Z$/.test(value)) fail('Некорректное время события'); return n; }
function text(value: string, max: number): string { const v = value.trim(); if (!v || v.length > max) fail('Проверьте обязательные поля'); return v; }
function id(value: string): string { if (!/^[a-zA-Z0-9_:-]{1,100}$/.test(value)) fail('Некорректный идентификатор действия'); return value; }
function duration(value: Duration): Duration { if (!['days', 'calendar_months'].includes(value.kind) || !Number.isSafeInteger(value.count) || value.count <= 0) fail('Некорректный период доступа'); return { ...value }; }
export function moneyFromRubles(value: string): string {
  const v = value.trim();
  if (!/^(0|[1-9]\d*)(?:[,.]\d{1,2})?$/.test(v)) fail('Введите сумму в рублях, не больше двух знаков после запятой');
  const [whole = '0', fraction = ''] = v.replace(',', '.').split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  try { assertPersistableMinor(amount); } catch { fail('Сумма слишком велика'); } return amount.toString();
}
export function rublesFromMinor(value: string): string { const n = parsePersistedMinor(value); if (n < 0n) fail('Сумма не может быть отрицательной'); return `${n / 100n},${(n % 100n).toString().padStart(2, '0')}`; }
export function moneyLabel(value: string): string { const n = parsePersistedMinor(value), a = n < 0n ? -n : n; return `${n < 0n ? '−' : ''}${new Intl.NumberFormat('ru-RU').format(a / 100n)}${a % 100n ? ',' + (a % 100n).toString().padStart(2, '0') : ''} ₽`; }
export function durationLabel(value: Duration): string { return value.kind === 'calendar_months' ? value.count === 1 ? '1 календарный месяц' : value.count === 3 ? '3 календарных месяца' : `${value.count} календарных месяцев` : `${value.count} дней`; }
export function dateLabel(value: string | null): string { return value ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'; }
export function requestStatus(request: AccessRequest, now: string): RequestStatus | 'expired' { return ['awaiting_email', 'awaiting_payment'].includes(request.status) && time(now) >= time(request.expiresAt) ? 'expired' : request.status; }
export function invitationStatus(invite: Invitation, now: string): Invitation['state'] { return invite.state === 'active' && time(now) >= time(invite.expiresAt) ? 'expired' : invite.state; }
export const statusLabel: Record<RequestStatus | 'expired', string> = { awaiting_email: 'Подтверждение почты', awaiting_payment: 'Ожидает оплаты', under_review: 'На проверке', needs_topup: 'Ожидает доплаты', paid_not_activated: 'Оплачено — ожидает регистрации', rejected: 'Отклонена', expired: 'Срок заявки истёк' };
export const invitationLabel: Record<Invitation['state'], string> = { active: 'Подготовлено', expired: 'Срок ссылки истёк', cancelled: 'Отменено', superseded: 'Заменено новым' };
export function receivedMinor(store: AccessStore, requestId: string): string { const total = store.payments.filter(p => p.requestId === requestId).reduce((n, p) => n + parsePersistedMinor(p.actualMinor), 0n); assertPersistableMinor(total); return total.toString(); }
export function createAccessRequest(store: AccessStore, input: { id: string; name: string; email: string; tariff: Tariff }, now: string): AccessStore {
  const email = text(input.email, 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Проверьте адрес электронной почты');
  if (store.requests.some(r => r.email === email && !['rejected', 'expired'].includes(requestStatus(r, now)))) fail('Для этой почты уже есть незавершённая заявка');
  if (store.requests.some(r => r.id === input.id)) fail('Заявка уже существует');
  const tariff = structuredClone(input.tariff); duration(tariff.duration);
  if (!tariff.active || !tariff.publicVisible || !tariff.availableForNew || parsePersistedMinor(tariff.priceMinor) <= 0n || !Number.isSafeInteger(tariff.aiQuota) || tariff.aiQuota < 0) fail('Тариф недоступен для новой заявки');
  const request: AccessRequest = { id: id(input.id), revision: 0, name: text(input.name, 100), email, tariff, status: 'awaiting_email', createdAt: now, expiresAt: new Date(time(now) + lifetime).toISOString(), verifiedAt: null, claimedAt: null, senderName: '', senderBank: '', decisionNote: '' };
  return { ...store, requests: [...store.requests, request] };
}
function find(store: AccessStore, requestId: string): AccessRequest { return store.requests.find(r => r.id === requestId) ?? fail('Заявка не найдена'); }
function replace(store: AccessStore, request: AccessRequest): AccessStore { return { ...store, requests: store.requests.map(r => r.id === request.id ? request : r) }; }
/** Trusted domain event: a future server adapter must authenticate the email-verification token. */
export function recordVerifiedEmail(store: AccessStore, requestId: string, now: string): AccessStore {
  const r = find(store, requestId); if (requestStatus(r, now) !== 'awaiting_email') fail('Подтверждение почты сейчас недоступно');
  return replace(store, { ...r, status: 'awaiting_payment', verifiedAt: now, revision: r.revision + 1 });
}
export function claimPayment(store: AccessStore, requestId: string, sender: { name: string; bank: string }, now: string): AccessStore {
  const r = find(store, requestId); if (requestStatus(r, now) !== 'awaiting_payment' || !r.verifiedAt) fail('Сначала подтвердите почту и проверьте срок заявки');
  time(now); return replace(store, { ...r, status: 'under_review', senderName: text(sender.name, 100), senderBank: text(sender.bank, 100), claimedAt: now, revision: r.revision + 1 });
}
function replay(store: AccessStore, actionId: string, payload: unknown): boolean { const key = id(actionId), encoded = JSON.stringify(payload); if (!Object.hasOwn(store.replay, key)) return false; if (store.replay[key] !== encoded) fail('Идентификатор уже использован для другого действия'); return true; }
function remember(store: AccessStore, actionId: string, payload: unknown): AccessStore { return { ...store, replay: { ...store.replay, [actionId]: JSON.stringify(payload) } }; }
function makeInvitation(request: AccessRequest, purchaseId: string, actionId: string, now: string): Invitation { return { id: 'invite:' + actionId, requestId: request.id, purchaseId, email: request.email, createdAt: now, expiresAt: new Date(time(now) + lifetime).toISOString(), state: 'active', delivery: 'not_connected' }; }
export function reviewRequest(store: AccessStore, cmd: ReviewCommand, now: string): AccessStore {
  if (replay(store, cmd.actionId, cmd)) return store;
  const r = find(store, cmd.requestId); time(now); id(cmd.actorId);
  if (!['under_review', 'needs_topup'].includes(requestStatus(r, now)) || !r.verifiedAt || !r.claimedAt) fail('Заявка сейчас не доступна для сверки оплаты');
  if (r.revision !== cmd.expectedRevision) fail('Заявка изменилась. Откройте актуальную карточку');
  const incoming = parsePersistedMinor(cmd.actualMinor); if (incoming < 0n) fail('Сумма не может быть отрицательной');
  const total = parsePersistedMinor(receivedMinor(store, r.id)) + incoming; assertPersistableMinor(total);
  const expected = parsePersistedMinor(r.tariff.priceMinor), mismatch = total !== expected;
  if (cmd.decision === 'confirm' && mismatch) fail('Полученная сумма отличается от тарифа. Выберите отдельное решение');
  if (cmd.decision === 'topup' && total >= expected) fail('Доплата не требуется');
  if (!['confirm', 'accept_full', 'topup', 'reject', 'custom'].includes(cmd.decision)) fail('Выберите решение');
  if (cmd.decision !== 'confirm') text(cmd.reason, 1000);
  const reason = cmd.reason.trim(); if (reason.length > 1000) fail('Сократите причину до 1000 символов');
  const receivedAt = cmd.receivedAt; if (time(receivedAt) > time(now) || time(receivedAt) < time(r.createdAt)) fail('Проверьте дату получения платежа');
  const selectedDuration = cmd.decision === 'custom' ? duration({ kind: 'days', count: cmd.customDays ?? 0 }) : duration(r.tariff.duration);
  const isGrant = ['confirm', 'accept_full', 'custom'].includes(cmd.decision);
  if (isGrant && total <= 0n) fail('Нет полученной оплаты. Бесплатный доступ выдаётся отдельным действием');
  const status: RequestStatus = isGrant ? 'paid_not_activated' : cmd.decision === 'topup' ? 'needs_topup' : 'rejected';
  let next = replace(store, { ...r, status, decisionNote: reason, revision: r.revision + 1 });
  if (incoming > 0n) next = { ...next, payments: [...next.payments, { id: 'payment:' + cmd.actionId, requestId: r.id, expectedMinor: r.tariff.priceMinor, actualMinor: incoming.toString(), receivedAt, recordedAt: now, senderName: r.senderName, senderBank: r.senderBank, method: 'manual_transfer', disposition: cmd.decision === 'reject' ? 'return_required' : 'recorded', actionId: cmd.actionId }] };
  if (cmd.decision === 'reject') next = { ...next, payments: next.payments.map(p => p.requestId === r.id ? { ...p, disposition: 'return_required' as const } : p) };
  if (isGrant) {
    const purchase: Purchase = { id: 'purchase:' + cmd.actionId, requestId: r.id, tariff: structuredClone(r.tariff), duration: selectedDuration, actualMinor: total.toString(), paidAt: now, state: 'paid_not_activated' };
    next = { ...next, purchases: [...next.purchases, purchase], invitations: [...next.invitations, makeInvitation(r, purchase.id, cmd.actionId, now)] };
  }
  const action: AuditEntry['action'] = cmd.decision === 'topup' ? 'topup_requested' : cmd.decision === 'reject' ? 'request_rejected' : cmd.decision === 'custom' ? 'custom_period_granted' : 'payment_confirmed';
  next = { ...next, audit: [...next.audit, { id: 'audit:' + cmd.actionId, requestId: r.id, actorId: cmd.actorId, at: now, action, reason }] };
  return remember(next, cmd.actionId, cmd);
}
export function changeInvitation(store: AccessStore, cmd: { actionId: string; invitationId: string; decision: 'cancel' | 'reissue'; actorId: string; reason: string }, now: string): AccessStore {
  if (replay(store, cmd.actionId, cmd)) return store;
  id(cmd.actorId); const invite = store.invitations.find(i => i.id === cmd.invitationId) ?? fail('Приглашение не найдено');
  const current = invitationStatus(invite, now); text(cmd.reason, 1000);
  const latest = store.invitations.filter(i => i.purchaseId === invite.purchaseId).at(-1);
  if (latest?.id !== invite.id || current === 'superseded' || (cmd.decision === 'cancel' && current !== 'active')) fail('Откройте последнее приглашение');
  if (!['cancel', 'reissue'].includes(cmd.decision)) fail('Неизвестное действие');
  let next: AccessStore = { ...store, invitations: store.invitations.map(i => i.id === invite.id ? { ...i, state: cmd.decision === 'cancel' ? 'cancelled' : current === 'active' ? 'superseded' : current } : i), audit: [...store.audit, { id: 'audit:' + cmd.actionId, requestId: invite.requestId, actorId: cmd.actorId, at: now, action: cmd.decision === 'cancel' ? 'invitation_cancelled' : 'invitation_reissued', reason: cmd.reason.trim() }] };
  if (cmd.decision === 'reissue') next = { ...next, invitations: [...next.invitations, makeInvitation(find(store, invite.requestId), invite.purchaseId, cmd.actionId, now)] };
  return remember(next, cmd.actionId, cmd);
}
