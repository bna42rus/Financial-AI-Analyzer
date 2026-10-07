# Сервер доступа и защиты: второй блок этапа 3

7 октября 2026. Продолжение интерфейса PR №7. Источники: PDF 38.2–38.8, 40.1–40.5, 40.8, 40.12, 40.14–40.15, A-07, C-02/C-06 и E-04. Исходные PDF/Word, baseline и порядок приоритета не меняются. Обязательная SMS recovery ветка заменена утверждённым E-04.

## Реализовано

- `apps/api`: NestJS/Fastify, два независимых deployment profiles; `finance_api` и `control_api` используют разные DB credentials. Control не загружает application/financial repository и не имеет GRANT на identity credentials, finance или protected keys.
- PostgreSQL 18/Drizzle: миграция auth realms, состояния аккаунта/доступа, сессий, application requests, токенов, security events, durable limits и encrypted outbox. API никогда не работает как migration owner или BYPASSRLS.
- Better Auth: email/password (Argon2id), DB-backed opaque sessions, закрытый signup, обязательный verified email. Native JSON session tokens не возвращаются браузеру. Separate host-only HttpOnly cookies, Secure при HTTPS, SameSite Strict, cookieCache выключен. Точный allowed Origin и JSON обязательны для writes; CORS сам по себе не даёт полномочия.
- Сброс пароля по custom случайному 256-bit token: SHA-256 verifier, срок 15 минут, только verified email, generic request response. После успешного reset атомарно меняются hash/epoch, уничтожаются все old sessions, все reset tokens и связанные challenges/contexts. Нужен новый login. Изменение пароля и encrypted security email фиксируются в той же DB transaction.
- Заявка создаётся с server-generated ID/time и snapshot из DB tariff. Скопированные client price/actor/ownership fields отклоняются. Незавершённая заявка не дублируется. Existing account не раскрывается в public response: его отдельный маршрут ставится в почтовую очередь.
- Подтверждение почты заявки: 30-minute single-use hashed token из защищённой очереди; POST body, а не query URL. Одновременное использование допускает только один успех. После proof создаётся собственная opaque application session на 72 часа, verifier хранится hashed. Это authority только на свою заявку, не financial/user/admin login.
- Sender/payment claim требует своей verified application session. Клиент не выбирает request ID. «Оплатил» переводит заявку в under_review и не создаёт payment, purchase или account. Verified-but-expired заявка не может начать claim; expiry уже claimed заявки соответствует domain model.
- Admin password login всегда требует TOTP после первого enrollment. Password-only session и initial enrollment не имеют admin capabilities. Native OTP, trusted-device, backup-code redemption, disable-2FA, social/passwordless/публичный signup и остальные неразрешённые endpoints закрыты.
- Native Better Auth TOTP secret дополнительно хранится через envelope encryption (fresh DEK, AES-256-GCM, KEK из защищённого Development environment). URI получает только enrollment session с повторной проверкой password. Native backup codes не выдаются и не принимаются. После verified TOTP enrollment сервер выдаёт один раз восемь собственных 256-bit recovery codes; verifier каждого hashed, admin reads их не показывают.
- E-04 recovery требует **свежую проверку password + неиспользованный code**. DB transaction атомарно потребляет code, отзывает все old admin sessions/challenges, уничтожает old TOTP, инвалидирует reset contexts и повышает epoch. Выдаётся 10-minute recovery-only session. До нового verified TOTP она не может читать очередь заявок. Password reset не заменяет code и не даёт enrollment/admin capabilities после recovery. Если recovery прерван/reset, оставшийся неиспользованный code позволяет начать его заново с актуальным password; старый набор codes ротируется только после успешного нового verified enrollment.
- Admin capability требует актуальных session + verified email + active status + matching epoch + verified TOTP proof. Доступ проверяется при каждом запросе; client role/id/cookies другого realm не дают полномочия. Read-only очередь ограничена 100 последними заявками.
- Пользовательские /session capabilities проверяют actual status/entitlement по серверному времени; expired/suspended дают restricted scope. Это пока контракт прав, не реализованная финансовая навигация. Session list не содержит tokens; revoke session проверяет её владельца.
- Durable IP/account rate limits сохраняются отдельно от main transaction и действуют между server instances. Native account-wide failed-TOTP counters сохраняются при неверном коде; enrollment/recovery session guessing ограничено дополнительно по account. Повтор успешного TOTP code блокируется на 90 секунд. Auth transactions сериализованы profile-scoped advisory lock; это временное ограничение throughput в пользу целостности первого блока.

## Границы API

| Маршрут | Finance/user profile | Control/admin profile |
| --- | --- | --- |
| POST /auth/sign-in/email, /auth/sign-out | Verified user login/logout | Password/TOTP challenge или restricted enrollment |
| POST /auth/two-factor/enable, /auth/two-factor/verify-totp | Закрыты | Password-checked restricted enrollment / challenge verification |
| POST /security/reset-request, /security/reset | Generic verified-email reset, no auto-login | Такой же reset, TOTP/recovery остаются обязательны |
| GET /session | Active/restricted capabilities | Enrollment/recovery/admin capabilities |
| GET /security/sessions, POST /security/revoke-session | Только свои sessions | Только свои sessions после TOTP |
| POST /access/requests, /access/verify | Application + email proof | Закрыты |
| GET /access/request, POST /access/payment-claim | Только своя application session | Закрыты |
| POST /control/recovery | Закрыт | Password + one-use recovery code → recovery-only session |
| GET /control/requests | Закрыт | TOTP-gated metadata queue, без finance/passwords/mail secrets |

No-store/no-referrer headers; bodies, tokens, email/password/SQL errors не пишутся в runtime logs или ответы об ошибках. /health не раскрывает DB/secret details. Tokens не хранятся в browser Storage.

## Проверка и ограничения результата

Локально прошли общий check, API strict TypeScript, две crypto проверки и прежние 62 web/16 admin browser scenarios. Локальный PostgreSQL daemon не стартовал: среда разрешает только UID 0 и не позволяет создать отдельного OS user. Поэтому real DB tests запускаются в GitHub CI на official PostgreSQL 18.4; это отмечается отдельно от локальных результатов.

23 integration scenarios проверяют реальные GRANT/RLS, отказ owner credentials, отсутствие tenant context после rollback/pool reuse, закрытые auth bypass paths, generic login/reset, price snapshot, concurrent verification/recovery, expiry/ownership, no grant from payment claim, mandatory TOTP, обычный новый TOTP login, одноразовые codes, старые sessions/challenges/TOTP после recovery, recovery-only enrollment, A-07 reset/invalidation, realm separation/restricted mode, CSRF/cookies/no-store, durable IP/account limits, shared failed-TOTP counters, own session revocation, encryption/read secrecy и rollback при недоступной outbox. Код тестов — `apps/api/test/security.test.ts`. Конкретный hosted run и итог фиксируются в PR после завершения.

**Это проверенный Development backend, а не готовый запуск.** Production startup явно заблокирован. Environment KEK — Development adapter; нужен выбранный audited KMS/envelope lifecycle. RLS проверен на isolation canary; actual financial repositories/таблицы/AI/HMAC ещё не существуют. Ручная сверка/приглашения PR №7 пока local UI/domain и не привязаны к этому API; control queue здесь только читает application metadata.

Queued emails зашифрованы, но delivery adapter/pg-boss worker, настоящие sent/failed/resend, SPF/DKIM/DMARC и проверка почтового провайдера ещё не подключены. Browser UI не может нажатием подтвердить реальные email; подтверждение требует token. Реальные тарифы и payment instructions не утверждены и не seed-ятся. Все integration fixtures — synthetic example.test, тестовые пароли/коды генерируются и не сохраняются как реальные credentials.

Реальный owner bootstrap с доказательством email ownership, auth/recovery UI с локальным QR и сохранением codes, invitation registration/activation, renewal, dangerous-action reauthentication/TOTP, email change/override, полная security history, revoke-other-sessions UI, password breach check/финальные password policy и параметры hash performance, expiry job integration, monitoring, queue/token/rate cleanup/retention и полная release/restore acceptance предстоят. Optional operator seed создаёт только Development example.test и не подтверждает реальную почту владельца.

## Следующий блок

Связать заявки/админку с API и провести invitation-only registration: сохранить manual payment и invitation атомарно, выдать scoped hashed invitation, отдельно доказать expected email, создать аккаунт/entitlement и начать оплаченный срок только при activation. Затем renewal. Production, покупки услуг и выпуск остаются отдельными решениями.

## Сверенные первичные технические источники

Better Auth [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), [email/password](https://better-auth.com/docs/authentication/email-password), [TOTP plugin](https://better-auth.com/docs/plugins/2fa), [sessions](https://better-auth.com/docs/concepts/session-management), [Fastify](https://better-auth.com/docs/integrations/fastify); [NestJS Fastify](https://docs.nestjs.com/techniques/performance); [PostgreSQL 18 RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html); [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Семантика проверена также по установленному коду pinned library, включая fields verified/lockout, challenge consumption и native backup-code behavior; native несовместимые endpoints не считаются принятой продуктовой реализацией.
