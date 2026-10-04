import { expect, test } from '@playwright/test';

test('first visit is empty; demo is opt-in, ephemeral and performs no financial network request', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:5173/') && !request.url().startsWith('ws://127.0.0.1:5173/')) externalRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{ name:'Начните с первой выписки' })).toBeVisible();
  await expect(page.getByTestId('expenses')).toHaveCount(0);
  await page.getByRole('button',{ name:'Посмотреть пример', exact:true }).click();
  await expect(page.getByTestId('expenses')).toHaveText('58 869 ₽');
  await expect(page.getByTestId('income')).toHaveText('120 000 ₽');
  await expect(page.getByTestId('difference')).toHaveText('61 131 ₽');
  await expect(page.getByTestId('attention')).toHaveText('2');
  await expect(page.getByText('Демонстрационный режим · вымышленные данные')).toBeVisible();
  const stored = await page.evaluate(() => ({ local:localStorage.length, session:sessionStorage.length }));
  expect(stored).toEqual({ local:0, session:0 });
  expect(externalRequests).toEqual([]);
  await page.reload();
  await expect(page.getByRole('heading',{ name:'Начните с первой выписки' })).toBeVisible();
});

test('bank and period filters control totals, empty result and negative refund-only data', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button',{ name:'Посмотреть пример', exact:true }).click();
  await page.getByLabel('Банк',{ exact:true }).selectOption('Сбер');
  await expect(page.getByTestId('expenses')).toHaveText('32 199 ₽');
  await expect(page.getByTestId('income')).toHaveText('120 000 ₽');
  await page.getByRole('button',{ name:'Сбросить фильтры' }).click();
  await page.getByLabel('С даты',{ exact:true }).fill('2026-09-18');
  await page.getByLabel('По дату',{ exact:true }).fill('2026-09-18');
  await expect(page.getByTestId('expenses')).toHaveText('−2 900 ₽');
  await expect(page.getByRole('button',{ name:'Одежда −2 900 ₽' })).toBeVisible();
  await page.getByLabel('По дату',{ exact:true }).fill('2026-10-31');
  await page.getByLabel('С даты',{ exact:true }).fill('2026-10-01');
  await expect(page.getByRole('heading',{ name:'За выбранный период операций нет' })).toBeVisible();
  await expect(page.getByTestId('expenses')).toHaveText('0 ₽');
});

test('explanation and drilldown preserve context and dialog keyboard behavior', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button',{ name:'Посмотреть пример', exact:true }).click();
  await page.getByRole('button',{ name:/^Расходы 58/ }).click();
  const explanation = page.getByRole('dialog');
  await expect(explanation.getByRole('heading',{ name:'Как рассчитаны расходы' })).toBeVisible();
  await expect(explanation.getByText('61 769 ₽',{ exact:true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(explanation).toBeHidden();
  await page.getByRole('button',{ name:'Жильё 32 000 ₽', exact:true }).click();
  await expect(page.getByRole('heading',{name:'Операции',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Александр · аренда',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Зарплата',exact:true})).toHaveCount(0);
  await expect(page.getByTestId('operation-count')).toHaveText('Показано 1 из 1');
});

test('viewport remains readable without horizontal overflow and errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button',{ name:'Посмотреть пример', exact:true }).click();
  await expect(page.getByRole('heading',{ name:'Обзор', exact:true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button',{ name:/Требуют внимания/ }).click();
  await expect(page.getByRole('heading',{name:'Операции',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Перевод Дмитрию',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
