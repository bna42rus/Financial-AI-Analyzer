import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function section(page: Page, title: string) {
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
async function example(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Посмотреть пример', exact: true }).click();
}

test('settings before import: ten sections, honest empty states, no network or storage', async ({ page }) => {
  const external: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:5173/') && !request.url().startsWith('ws://127.0.0.1:5173/')) external.push(request.url()); });
  await page.goto('/#settings');
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button')).toHaveCount(10);
  for (const [title, text] of [['Счета', 'Счетов пока нет'], ['Загрузки', 'Загрузок пока нет'], ['Правила', 'Личных правил пока нет'], ['Контрагенты', 'Контрагентов пока нет'], ['Бюджеты', 'Бюджетов пока нет'], ['История', 'История пока пуста']]) {
    await section(page, title!);
    await expect(page.getByRole('heading', { name: text!, exact: true })).toBeVisible();
  }
  await section(page, 'Категории');
  await page.getByText('Продукты', { exact: true }).click();
  await expect(page.getByText('Магазины; Доставка продуктов; Прочие продукты', { exact: true })).toBeVisible();
  await section(page, 'Конфиденциальность');
  await expect(page.getByText('AI-классификация', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Удалить|Export|Экспорт/ })).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(external).toEqual([]);
});

test('settings search finds parameter synonyms and recovers from an empty result', async ({ page }) => {
  await page.goto('/#settings');
  const search = page.getByRole('searchbox', { name: 'Поиск настроек' });
  await search.fill('  ТЁМНАЯ  ');
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Интерфейс', exact: true })).toBeVisible();
  await search.fill('исключённые');
  await expect(page.getByRole('button', { name: 'Аналитика', exact: true })).toBeVisible();
  await search.fill('несуществующий параметр');
  await expect(page.getByText('Настройка не найдена. Попробуйте другое слово.')).toBeVisible();
  await page.getByRole('button', { name: 'Очистить поиск настроек' }).click();
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button')).toHaveCount(10);
});

test('appearance changes actual styles, follows system theme and remains across navigation', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/#settings/interface');
  const initialFont = await page.locator('body').evaluate(e => parseFloat(getComputedStyle(e).fontSize));
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light dark');
  const systemBackground = await page.locator('body').evaluate(e => getComputedStyle(e).backgroundColor);
  await page.getByLabel('Тема', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  expect(await page.locator('body').evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe(systemBackground);
  await page.getByLabel('Тема', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', systemBackground);
  const comfortablePadding = await page.locator('[data-section="accounts"]').evaluate(e => parseFloat(getComputedStyle(e).paddingTop));
  await page.getByLabel('Плотность', { exact: true }).selectOption('compact');
  expect(await page.locator('[data-section="accounts"]').evaluate(e => parseFloat(getComputedStyle(e).paddingTop))).toBeLessThan(comfortablePadding);
  await page.getByLabel('Размер текста', { exact: true }).selectOption('large');
  await page.getByLabel('Анимация', { exact: true }).selectOption('reduced');
  expect(await page.locator('body').evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThan(initialFont);
  await page.getByRole('link', { name: 'Обзор', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await section(page, 'Интерфейс');
  await expect(page.getByLabel('Размер текста', { exact: true })).toHaveValue('large');
  await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('dark');
  expect(await page.evaluate(() => ({keys:Object.keys(localStorage),session:sessionStorage.length,value:JSON.parse(localStorage.getItem('finance-appearance-v1')!)}))).toEqual({keys:['finance-appearance-v1'],session:0,value:{theme:'dark',density:'compact',textSize:'large',motion:'reduced'}});
  await page.reload();
  await expect(page.getByLabel('Тема', {exact:true})).toHaveValue('dark');
});

test('account and exclusion links open the exact rows even after restrictive filters', async ({ page }) => {
  await example(page);
  await page.evaluate(() => window.location.hash = '#operations');
  await section(page, 'Счета');
  await page.getByRole('button', { name: 'Операции счёта: Альфа-Банк — Накопительный', exact: true }).click();
  await expect(page.getByTestId('operation-count')).toHaveText('Показано 1 из 1');
  await expect(page.getByRole('button', { name: 'С основного счёта', exact: true })).toBeVisible();
  await expect(page.getByText('Из Настроек: Альфа-Банк — Накопительный', { exact: true })).toBeVisible();
  await section(page, 'Аналитика');
  await page.getByRole('button', { name: 'Показать исключённые операции', exact: true }).click();
  await expect(page.getByTestId('operation-count')).toHaveText('Показано 1 из 1');
  await expect(page.getByRole('button', { name: 'Онлайн-кинотеатр', exact: true })).toBeVisible();
  await expect(page.getByTestId('operation-expenses')).toHaveText('0 ₽');
  await expect(page.getByText('Из Настроек: Исключённые операции', { exact: true })).toBeVisible();
});

test('appearance reset preserves filters, financial rows and Analyzer conversations; reload clears demo', async ({ page }, info) => {
  await example(page);
  await page.getByRole('link', { name: 'Анализатор', exact: true }).click();
  await page.getByRole('button', { name: /^Сколько я потратил за выбранный период\?/ }).click();
  await expect(page.getByRole('log')).toContainText('58 869 ₽');
  await section(page, 'Интерфейс');
  await page.getByLabel('Тема', { exact: true }).selectOption('dark');
  await page.getByLabel('Плотность', { exact: true }).selectOption('compact');
  await page.getByLabel('Размер текста', { exact: true }).selectOption('large');
  await page.getByRole('button', { name: 'Сбросить оформление', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Оформление сброшено. Данные и фильтры сохранены.');
  await expect(page.getByLabel('Тема', { exact: true })).toHaveValue('system');
  await expect(page.getByLabel('Плотность', { exact: true })).toHaveValue('comfortable');
  await expect(page.getByLabel('Размер текста', { exact: true })).toHaveValue('standard');
  await page.getByRole('link', { name: 'Анализатор', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('58 869 ₽');
  await page.getByRole('link', { name: 'Обзор', exact: true }).click();
  await expect(page.getByTestId('expenses')).toHaveText('58 869 ₽');
  await page.getByLabel('Банк', { exact: true }).selectOption('Сбер');
  await section(page, 'Интерфейс');
  await page.getByRole('button', { name: 'Сбросить оформление', exact: true }).click();
  await page.getByRole('link', { name: 'Обзор', exact: true }).click();
  await expect(page.getByTestId('expenses')).toHaveText('32 199 ₽');
  await section(page, 'Счета');
  await expect(page.getByRole('button', { name: /Операции счёта:/ })).toHaveCount(3);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Все настройки', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Счета', exact: true })).toBeFocused();
  }
  await page.reload();
  await section(page, 'Счета');
  await expect(page.getByRole('heading', { name: 'Счетов пока нет' })).toBeVisible();
});

test('settings routes, back navigation, focus and large text fit narrow screens', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Интерфейс', exact: true }).click();
  await expect(page).toHaveURL(/#settings\/interface$/);
  await expect(page.getByRole('heading', { name: 'Интерфейс', exact: true })).toBeFocused();
  await page.getByLabel('Размер текста', { exact: true }).selectOption('large');
  await page.getByLabel('Тема', { exact: true }).selectOption('dark');
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Сбросить оформление', exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 1280, height: 850 });
  await page.goBack();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByRole('button', { name: 'Конфиденциальность', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Конфиденциальность', exact: true }).click();
  await page.getByRole('link', { name: /Финансовый анализатор/ }).click();
  await expect(page.getByRole('heading', { name: 'Обзор', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
