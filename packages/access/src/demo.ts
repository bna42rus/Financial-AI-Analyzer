import { claimPayment, createAccessRequest, emptyAccessStore, recordVerifiedEmail, reviewRequest } from './model.ts';
import type { AccessStore, Tariff } from './model.ts';

/** Synthetic fixtures, opt-in only. Prices/quotas are examples, not approved offers. */
export const demoTariffs: Tariff[] = [
  { id: 'example-week', name: 'На неделю', duration: { kind: 'days', count: 7 }, priceMinor: '39000', aiQuota: 30, publicVisible: true, availableForNew: true, active: true },
  { id: 'example-month', name: 'На месяц', duration: { kind: 'calendar_months', count: 1 }, priceMinor: '119000', aiQuota: 150, publicVisible: true, availableForNew: true, active: true },
  { id: 'example-quarter', name: 'На три месяца', duration: { kind: 'calendar_months', count: 3 }, priceMinor: '249000', aiQuota: 450, publicVisible: true, availableForNew: true, active: true },
];
export function seedAccessExample(now: string): AccessStore {
  let store = emptyAccessStore();
  const at = (hours: number) => new Date(Date.parse(now) - hours * 3600000).toISOString();
  const legacy: Tariff = { ...demoTariffs[1]!, priceMinor: '99000' };
  const rows = [
    ['demo-anna', 'Анна Смирнова', 'anna@example.test', 'Анна Смирнова', 'Банк А', 'review'],
    ['demo-ivan', 'Иван Петров', 'ivan@example.test', 'Иван Петров', 'Банк Б', 'review'],
    ['demo-elena', 'Елена Волкова', 'elena@example.test', 'Елена Волкова', 'Банк А', 'paid'],
    ['demo-maria', 'Мария Орлова', 'maria@example.test', '', '', 'payment'],
    ['demo-sergey', 'Сергей Лебедев', 'sergey@example.test', '', '', 'email'],
  ];
  for (const row of rows) {
    const [requestId, name, email, sender, bank, state] = row as [string, string, string, string, string, string];
    store = createAccessRequest(store, { id: requestId, name, email, tariff: legacy }, at(30));
    if (state !== 'email') store = recordVerifiedEmail(store, requestId, at(29));
    if (['review', 'paid'].includes(state)) store = claimPayment(store, requestId, { name: sender, bank }, at(2));
    if (state === 'paid') store = reviewRequest(store, { actionId: 'seed-confirm', requestId, expectedRevision: 2, actorId: 'demo-owner', actualMinor: '99000', receivedAt: at(2), decision: 'confirm', reason: '' }, at(1));
  }
  return store;
}
