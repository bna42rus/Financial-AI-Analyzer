# Рабочие правила проекта

- Читать docs/product/source-manifest.json и соответствующие разделы полного PDF перед изменением поведения. PDF основной, Word контекст, approved A/B overrides в названных вопросах; согласованное E-04 заменяет обязательный admin SMS recovery. Технические решения E имеют приоритет над конфликтующими рекомендациями C/D только в указанном объёме; E-08 остаётся открытым. Baseline не заменяет PDF.
- Не упрощать принятую продуктовую модель без конкретного обоснования и решения владельца. При противоречии отметить источник и не выдумывать правило.
- Проверять изменения по privacy, imports/dedupe/provenance, links/components, Analyzer Action Registry, access/security, deletion и release workflow.
- Raw statements/passwords/identifiers и реальные клиентские финансовые данные не помещать в Git, AI, logs или Staging.
- Суммы integer minor units, никакого float money. Bank facts, user corrections и effective fields раздельны. Components не считаются вместе с полной parent transaction.
- Runtime authorization только серверная; ownership/user status/entitlement проверяются в разрешённых действиях до preview и перед commit. Client identifiers не дают authority.
- AI не получает произвольный SQL и доступ к password/email/sessions/admin/access/HMAC. Closed versioned Registry.
- До Production нужны полные checks, Staging acceptance владельца, конкретный approved artifact, migrations и rollback/forward-fix plan. Админка не деплоит приложение.
- Новая работа в feature branch. Деньги/услуги не приобретаются без отдельного решения владельца.
