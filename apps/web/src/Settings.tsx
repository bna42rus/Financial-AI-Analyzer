import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, CreditCard, FolderTree, History, ListFilter, Palette, Search, ShieldCheck, Target, Upload, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DemoOperation } from './demo/overview';
import common from './App.module.css';
import styles from './Settings.module.css';

export interface Appearance {
  theme: 'system' | 'light' | 'dark';
  density: 'comfortable' | 'compact';
  textSize: 'standard' | 'large';
  motion: 'system' | 'reduced' | 'full';
}
export const defaultAppearance: Appearance = { theme: 'system', density: 'comfortable', textSize: 'standard', motion: 'system' };
const sections = [
  { id: 'accounts', title: 'Счета', description: 'Банки и названия счетов', keywords: 'карта тип видимость переименовать', icon: CreditCard },
  { id: 'imports', title: 'Загрузки', description: 'Выписки и результаты обработки', keywords: 'импорт файлы дубликаты отмена', icon: Upload },
  { id: 'categories', title: 'Категории', description: 'Расходы, доходы и подкатегории', keywords: 'справочник дерево объединить', icon: FolderTree },
  { id: 'rules', title: 'Правила', description: 'Повторяющиеся операции', keywords: 'классификация условия приоритет', icon: BookOpen },
  { id: 'counterparties', title: 'Контрагенты', description: 'Люди и организации', keywords: 'получатели переводы человек', icon: Users },
  { id: 'budgets', title: 'Бюджеты', description: 'Планы расходов', keywords: 'лимиты план категории период', icon: Target },
  { id: 'analytics', title: 'Аналитика', description: 'Учёт и исключения', keywords: 'кредиты погашение cashflow economic валюта рубли исключенные', icon: ListFilter },
  { id: 'interface', title: 'Интерфейс', description: 'Тема, текст и плотность', keywords: 'оформление темная светлая шрифт размер анимация движение сброс представления', icon: Palette },
  { id: 'privacy', title: 'Конфиденциальность', description: 'Данные и внешние подключения', keywords: 'ai интернет поиск магазинов приватность удалить удаление', icon: ShieldCheck },
  { id: 'history', title: 'История', description: 'Изменения и восстановление', keywords: 'undo откат отменить тридцать 30 дней', icon: History },
] as const satisfies readonly { id: string; title: string; description: string; keywords: string; icon: LucideIcon }[];
type Section = typeof sections[number]['id'];
function selectedSection(): Section | null {
  const id = window.location.hash.split('/')[1];
  return sections.find(section => section.id === id)?.id ?? null;
}
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim();
const starterExpenses: readonly [string, string][] = [
  ['Продукты', 'Магазины; Доставка продуктов; Прочие продукты'],
  ['Еда вне дома', 'Рестораны и кафе; Доставка готовой еды'],
  ['Жильё и дом', 'Аренда; Коммунальные услуги; Ремонт; Товары для дома; Бытовые услуги'],
  ['Транспорт', 'Такси; Общественный транспорт; Каршеринг; Самокаты и велосипеды; Топливо; Парковки и дороги; Обслуживание автомобиля; Прочий транспорт'],
  ['Здоровье и спорт', 'Аптеки; Врачи; Анализы и диагностика; Фитнес и спорт; Спортивные товары'],
  ['Одежда и аксессуары', 'Одежда; Обувь; Аксессуары'],
  ['Красота и уход', 'Парикмахерские и салоны; Косметика и уход; Прочий уход'],
  ['Связь и интернет', 'Мобильная связь; Домашний интернет; Прочая связь'],
  ['Подписки и цифровые сервисы', 'Видео и музыка; Облачные сервисы; ПО и приложения; AI-сервисы; VPN; Прочие подписки'],
  ['Развлечения и хобби', 'Кино и мероприятия; Игры; Хобби; Книги; Прочие развлечения'],
  ['Образование', 'Курсы; Обучение; Учебные материалы'],
  ['Путешествия', 'Авиабилеты; Ж/д билеты; Другой междугородний транспорт; Отели; Туры; Расходы в поездке'],
  ['Подарки и благотворительность', 'Подарки; Благотворительность'],
  ['Семья и дети', 'Детские товары; Образование детей; Кружки и секции; Прочие расходы на детей'],
  ['Питомцы', 'Корм и товары; Ветеринар; Уход; Прочие расходы'],
  ['Кредиты и долги', 'Платежи по кредитам; Проценты; Страхование по кредиту; Прочие расходы по кредитам'],
  ['Банковские услуги', 'Обслуживание; Комиссии; Уведомления; Прочие банковские услуги'],
  ['Налоги и обязательные платежи', 'Налоги; Штрафы; Госпошлины'],
  ['Работа и бизнес', 'Рабочие расходы; Сервисы для работы; Реклама; Прочие бизнес-расходы'],
  ['Прочие расходы', 'Без подкатегорий'],
];
const starterIncome: readonly [string, string][] = [
  ['Зарплата', 'Основная зарплата; Премии'], ['Подработка и фриланс', 'Фриланс; Разовые работы'],
  ['Бизнес', 'Выручка; Прочие бизнес-доходы'], ['Продажи', 'Продажа вещей; Прочие продажи'],
  ['Кэшбэк и бонусы', 'Кэшбэк; Банковские бонусы'],
  ['Проценты и инвестиции', 'Проценты по счетам и вкладам; Дивиденды; Прочие инвестиционные доходы'],
  ['Арендный доход', 'Аренда недвижимости; Прочая аренда'], ['Подарки и помощь', 'Денежные подарки; Финансовая помощь'],
  ['Государственные выплаты', 'Пособия и выплаты; Налоговые возвраты/вычеты'], ['Прочие доходы', 'Без подкатегорий'],
];
interface Props {
  operations: readonly DemoOperation[];
  appearance: Appearance;
  loading: boolean;
  onAppearanceChange: (appearance: Appearance) => void;
  onShowDemo: () => Promise<void>;
  onOpenOperations: (label: string, rows: readonly DemoOperation[]) => void;
  onUpload: () => void;
  historyOperation: DemoOperation | null;
  onClearHistory: () => void;
}

export function Settings({ operations, appearance, loading, onAppearanceChange, onShowDemo, onOpenOperations, onUpload, historyOperation, onClearHistory }: Props) {
  const [section, setSection] = useState<Section | null>(selectedSection);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const lastSection = useRef<Section>('accounts');
  const menu = useRef<HTMLElement>(null);
  useEffect(() => {
    const restore = () => setSection(selectedSection());
    window.addEventListener('popstate', restore); window.addEventListener('hashchange', restore);
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('hashchange', restore); };
  }, []);
  useEffect(() => {
    if (section) heading.current?.focus();
    else if (window.matchMedia('(max-width: 700px)').matches) menu.current?.querySelector<HTMLButtonElement>(`[data-section="${lastSection.current}"]`)?.focus();
  }, [section]);
  const visible = sections.filter(item => normalize(`${item.title} ${item.description} ${item.keywords}`).includes(normalize(query)));
  const current = sections.find(item => item.id === section) ?? sections[0];
  const accounts = [...new Set(operations.map(row => JSON.stringify([row.bank, row.account])))].map(key => {
    const [bank, name] = JSON.parse(key) as [string, string];
    return { bank, name, rows: operations.filter(row => row.bank === bank && row.account === name) };
  });
  const excluded = operations.filter(row => row.excluded);
  function open(next: Section | null) {
    onClearHistory();
    if (next) lastSection.current = next;
    setSection(next); setNotice('');
    const hash = next ? '#settings/' + next : '#settings';
    if (window.location.hash !== hash) window.history.pushState(null, '', hash);
  }
  function empty(title: string, text: string) {
    return <div className={styles.empty}><div className={styles.emptyIcon}><current.icon size={25} aria-hidden="true" /></div><h3>{title}</h3><p>{text}</p></div>;
  }
  function info(label: string, value: string, description?: string) {
    return <div className={styles.infoRow}><dt>{label}</dt><dd>{value}{description && <small>{description}</small>}</dd></div>;
  }
  function categories(rows: readonly [string, string][]) {
    return rows.map(([name, children]) => <details key={name} className={styles.category}><summary>{name}</summary><p>{children}</p></details>);
  }
  function content() {
    switch (current.id) {
      case 'accounts': return <>
        {accounts.length ? <div className={styles.accounts}>{accounts.map(account => <article className={styles.account} key={JSON.stringify([account.bank, account.name])}><div className={styles.accountIcon}><CreditCard size={20} aria-hidden="true" /></div><div><h3>{account.name}</h3><p>{account.bank} · Операций: {account.rows.length}</p></div><button className={common.button} aria-label={`Операции счёта: ${account.bank} — ${account.name}`} onClick={() => onOpenOperations(`${account.bank} — ${account.name}`, account.rows)}>Операции <ArrowRight size={15} aria-hidden="true" /></button></article>)}</div> : <>{empty('Счетов пока нет', 'Счета появятся после загрузки выписок. Здесь будут банк, понятное название и настройки каждого счёта.')}<div className={styles.emptyAction}><button className={common.button} onClick={() => void onShowDemo()} disabled={loading}>{loading ? 'Открываем пример…' : 'Посмотреть пример'}</button></div></>}
        <p className={styles.note}>В этой версии счета доступны для просмотра. Переименование, тип, видимость и объединение подключим позже. Номера карт и счетов здесь не отображаются.</p>
      </>;
      case 'imports': return <>{empty('Загрузок пока нет', operations.length ? 'Вымышленный пример открыт без загрузки файлов. Он не создаёт запись в истории импорта.' : 'Здесь будут результаты загрузки: новые операции, повторы и записи, требующие проверки.')}<div className={styles.emptyAction}><button className={common.primaryButton} onClick={onUpload}>Выбрать выписки</button></div><p className={styles.note}>Выбор файлов доступен. Их обработка и отмена импорта пока не подключены. Отмена загрузки не восстанавливается обычным Undo.</p></>;
      case 'categories': return <><p className={styles.description}>Стартовый справочник можно будет менять под себя: добавлять, переименовывать и объединять категории. Сейчас доступен просмотр.</p>{operations.length > 0 && <details className={styles.exampleCategories}><summary>Категории вымышленного примера</summary><p>{[...new Set(operations.map(row => row.category).filter(Boolean))].join(' · ')}</p></details>}<h3 className={styles.groupTitle}>Расходы</h3>{categories(starterExpenses)}<h3 className={styles.groupTitle}>Доходы</h3>{categories(starterIncome)}<p className={styles.note}>Переводы, возвраты и наличные — виды операций, а не отдельные экономические категории.</p></>;
      case 'rules': return <>{empty('Личных правил пока нет', 'Правила помогут узнавать повторяющиеся операции: магазин, аренду или регулярный платёж.')}<p className={styles.note}>Создание, приоритеты и применение правил к прошлым операциям появятся позже. Вымышленный пример не создаёт личных правил.</p></>;
      case 'counterparties': return <>{empty('Контрагентов пока нет', 'Здесь будут люди и организации, которых вы добавили или подтвердили. Разовые получатели переводов не добавляются автоматически.')}<p className={styles.note}>Предложения повторяющихся получателей будут показаны отдельно. Создание, объединение и исправление карточек пока недоступны.</p></>;
      case 'budgets': return <>{empty('Бюджетов пока нет', 'Здесь можно будет задавать планы расходов и сравнивать их с фактическими тратами за выбранный период.')}<p className={styles.note}>Создание и изменение бюджетов пока недоступны. Плановые суммы не подставляются из примера.</p></>;
      case 'analytics': return <><dl className={styles.info}>{info('Валюта общей аналитики', 'Российский рубль (₽)')}{info('Обычные кредиты', 'Весь платёж учитывается как расход', 'Для отдельного кредита можно будет выбрать другую модель.')}{info('Свои переводы', 'Не входят в расходы и доходы')}{info('Погашение кредитной карты', 'Не учитывается повторно как расход')}{info('Возвраты', 'Уменьшают расходы своей категории')}{info('Неопределённый смысл операции', 'Не входит в расходы и доходы')}</dl><div className={styles.exclusions}><div><h3>Исключения</h3><p>Исключённые операции остаются в списке, но не входят в обычные итоги.</p></div><span className={styles.count}>{excluded.length}</span></div>{excluded.length > 0 ? <button className={common.button} onClick={() => onOpenOperations('Исключённые операции', excluded)}>Показать исключённые операции <ArrowRight size={16} aria-hidden="true" /></button> : <p className={styles.note}>Исключённых операций нет.</p>}<p className={styles.note}>Изменение финансовых параметров и создание исключений подключим позже.</p></>;
      case 'interface': return <>
        <p className={styles.description}>Выберите удобное оформление. Сейчас оно действует на этой странице до перезагрузки.</p>
        <div className={styles.appearance}>
          <label>Тема<select aria-label="Тема" value={appearance.theme} onChange={e => onAppearanceChange({ ...appearance, theme: e.target.value as Appearance['theme'] })}><option value="system">Как на устройстве</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select><small>Цвета всех экранов и окон.</small></label>
          <label>Плотность<select aria-label="Плотность" value={appearance.density} onChange={e => onAppearanceChange({ ...appearance, density: e.target.value as Appearance['density'] })}><option value="comfortable">Комфортная</option><option value="compact">Компактная</option></select><small>Расстояния между записями и блоками.</small></label>
          <label>Размер текста<select aria-label="Размер текста" value={appearance.textSize} onChange={e => onAppearanceChange({ ...appearance, textSize: e.target.value as Appearance['textSize'] })}><option value="standard">Обычный</option><option value="large">Крупный</option></select><small>Размер подписей и основного текста.</small></label>
          <label>Анимация<select aria-label="Анимация" value={appearance.motion} onChange={e => onAppearanceChange({ ...appearance, motion: e.target.value as Appearance['motion'] })}><option value="system">Как на устройстве</option><option value="reduced">Уменьшить движение</option><option value="full">Обычная</option></select><small>Системное уменьшение движения учитывается по умолчанию.</small></label>
        </div><div className={styles.reset}><div><h3>Сбросить оформление</h3><p>Вернуть тему устройства, комфортную плотность и обычный текст. Операции, диалоги и фильтры сохранятся.</p></div><button className={common.button} onClick={() => { onAppearanceChange({ ...defaultAppearance }); setNotice('Оформление сброшено. Данные и фильтры сохранены.'); }}>Сбросить оформление</button></div>
        <p className={styles.notice} role="status">{notice}</p>
        <details className={styles.category}><summary>Стартовый экран и сохранённые представления</summary><p>Сейчас сайт начинает с Обзора или экрана из ссылки. Выбор стартового экрана и управление сохранёнными представлениями подключим позже.</p></details>
      </>;
      case 'privacy': return <><p className={styles.description}>Сейчас доступны только вымышленные данные в памяти страницы. При перезагрузке они исчезают; финансовые сведения не отправляются во внешние сервисы.</p><dl className={styles.info}>{info('AI-классификация', 'Не подключена', 'Будет отдельный переключатель автоматической классификации.')}{info('Поиск магазинов в интернете', 'Не подключён', 'Будет управляться отдельно от AI-классификации.')}{info('Интернет в Анализаторе', 'Не подключён', 'Будет отдельное разрешение для финансовых вопросов.')}</dl><div className={styles.danger}><h3>Удаление финансовых данных</h3><p>Удаление будет доступно после подключения хранения данных. Перед ним система покажет состав и количество удаляемых объектов. Физическое удаление не восстанавливается через Undo.</p><p>Для обратимого исключения используйте раздел «Аналитика».</p></div></>;
      case 'history': return <>{historyOperation && <div className={styles.historyScope}><p>История операции: <strong>{historyOperation.merchant}</strong><small>{historyOperation.bank} · {historyOperation.account}</small></p><button className={common.button} onClick={onClearHistory}>Показать всю историю</button></div>}{empty('История пока пуста', historyOperation ? 'Изменения этой операции пока не записываются. Вымышленный пример открыт для просмотра.' : 'Здесь будут изменения категорий, счетов, правил, бюджетов и других финансовых параметров. Навигация и временные фильтры не создают записи.')}<dl className={styles.info}>{info('Доступный период истории', '30 дней', 'Хранение истории и Undo пока не подключены.')}{info('Удаление и отмена импорта', 'Без обычного Undo', 'Перед восстановлением других изменений будут проверяться более поздние правки.')}</dl></>;
    }
  }
  return <section className={`${styles.settings} ${section ? styles.detailOpen : ''}`} aria-label="Настройки сайта">
    <aside className={styles.sidebar}>
      <label className={styles.search}><Search size={18} aria-hidden="true" /><input type="search" placeholder="Найти настройку" aria-label="Поиск настроек" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Очистить поиск настроек" onClick={() => setQuery('')}><X size={17} aria-hidden="true" /></button>}</label>
      <nav className={styles.menu} aria-label="Разделы настроек" ref={menu}>{visible.map(item => <button key={item.id} data-section={item.id} aria-label={item.title} aria-current={current.id === item.id ? 'page' : undefined} onClick={() => open(item.id)}><item.icon size={19} aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.description}</small></span><ChevronRight size={16} aria-hidden="true" /></button>)}</nav>
      {!visible.length && <p className={styles.noResults} role="status">Настройка не найдена. Попробуйте другое слово.</p>}
      <p className={styles.sidebarNote}>Оформление можно менять сейчас. Финансовые параметры доступны для просмотра.</p>
    </aside>
    <div className={styles.detail}>
      <button className={`${common.button} ${styles.back}`} onClick={() => open(null)}><ArrowLeft size={16} aria-hidden="true" />Все настройки</button>
      <div className={styles.sectionHead}><div className={styles.sectionIcon}><current.icon size={23} aria-hidden="true" /></div><div><h2 tabIndex={-1} ref={heading}>{current.title}</h2><p>{current.description}</p></div>{current.id !== 'interface' && <span className={styles.readOnly}>Просмотр</span>}</div>
      {content()}
    </div>
  </section>;
}
