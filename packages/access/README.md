# Модель первого доступа

`src/model.ts` содержит чистые переходы: заявка со snapshot тарифа, событие подтверждения email, payment claim, ручная сверка, отдельные платежи/доплаты, pending purchase и metadata приглашений. Суммы — строки целых копеек и bigint. Action ID защищает повторное применение в одном переданном состоянии; expected revision отклоняет устаревший preview. `test/model.test.ts` содержит 16 проверок правил.

Это доменная модель, не HTTP API и не проверка полномочий. `recordVerifiedEmail` принимает внутреннее trusted event: будущий сервер обязан проверить token и владение ожидаемой почтой до этого вызова. Review/invitation events должны приниматься только сервером после admin session/TOTP и runtime validation. Клиентские поля actorId и revision не дают authority.

Пока отсутствуют persistence, транзакции/блокировки и атомарная concurrency между процессами, защищённые verification/invitation tokens, delivery outbox, Better Auth и entitlement activation/renewal/calendar-anchor. Эти требования не закрываются моделью. `src/demo.ts` — только явно включаемые synthetic fixtures, без реальных клиентов и согласованных цен.
