import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function upload(page: Page) { await page.getByRole('button', { name: 'Загрузить файлы', exact: true }).click(); return page.getByRole('dialog', { name: 'Загрузка выписок', exact: true }); }
async function profile(page: Page) { await page.getByRole('button', { name: 'Профиль', exact: true }).click(); return page.getByRole('dialog', { name: 'Профиль', exact: true }); }
const statement = { name: 'пример.pdf', mimeType: 'application/pdf', buffer: Buffer.from('SYNTHETIC_PRIVATE_BYTES') };

test('upload opens from every screen and empty CTA, traps focus and clears selection on close', async ({ page }) => {
  await page.goto('/');
  const emptyCTA = page.getByRole('button', { name: 'Загрузить первую выписку', exact: true });
  await emptyCTA.click();
  const dialog = page.getByRole('dialog', { name: 'Загрузка выписок', exact: true });
  await expect(dialog.getByRole('button', { name: 'Выбрать файлы', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await dialog.getByLabel('Файлы выписок').setInputFiles(statement);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden(); await expect(emptyCTA).toBeFocused();
  for (const name of ['Обзор', 'Операции', 'Анализатор', 'Настройки']) {
    await page.getByRole('link', { name, exact: true }).click();
    const modal = await upload(page);
    await expect(modal.getByRole('list', { name: 'Выбранные файлы' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Загрузить файлы', exact: true })).toBeFocused();
  }
  await page.goto('/#settings/imports');
  await page.getByRole('button', { name: 'Выбрать выписки', exact: true }).click();
  await dialog.getByRole('button', { name: 'История загрузок', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(page).toHaveURL(/#settings\/imports$/);
  await expect(page.getByRole('heading', { name: 'Загрузок пока нет' })).toBeVisible();
});

test('file selection never reads bytes, sends data or seeds operations; bad files and repeated choices stay distinct', async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ['text', 'arrayBuffer', 'slice', 'stream']) Object.defineProperty(File.prototype, method, { value() { throw new Error('Unexpected raw file read'); } });
  });
  const requests: string[] = []; const errors: string[] = []; const logs: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:5173/') || request.method() !== 'GET') requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => logs.push(message.text()));
  await page.goto('/'); const dialog = await upload(page);
  await dialog.getByLabel('Файлы выписок').setInputFiles([statement, { name: 'неподдерживаемый.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') }, { name: 'пустой.csv', mimeType: 'text/csv', buffer: Buffer.from('') }]);
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await expect(dialog.getByText('Выберите PDF, CSV или XLSX.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Файл пустой. Выберите другую копию выписки.', { exact: true })).toBeVisible();
  await dialog.getByLabel('Файлы выписок').setInputFiles(statement);
  await expect(dialog.getByRole('listitem')).toHaveCount(4);
  await dialog.getByRole('button', { name: 'Убрать файл: пример.pdf', exact: true }).first().click();
  await expect(dialog.getByRole('status')).toHaveText('Выбрано файлов: 3. Обработка не запускалась.');
  await dialog.getByRole('button', { name: 'Очистить выбор', exact: true }).click();
  await expect(dialog.getByRole('listitem')).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.getByRole('link', { name: 'Операции', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Здесь будут ваши операции' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(requests).toEqual([]); expect(errors).toEqual([]); expect(logs.join(' ')).not.toContain('SYNTHETIC_PRIVATE_BYTES');
});

test('drop adds only local file metadata and history navigation creates no import', async ({ page }) => {
  await page.goto('/'); const dialog = await upload(page);
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['synthetic'], 'выписка.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); return data; });
  await dialog.locator('[aria-label="Выбор выписок"]').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(dialog.getByText('выписка.xlsx', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Обработка пока не подключена', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'История загрузок', exact: true }).click();
  await expect(page).toHaveURL(/#settings\/imports$/);
  await expect(page.getByRole('heading', { name: 'Загрузок пока нет' })).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать выписки', exact: true }).click();
  await expect(dialog.getByRole('listitem')).toHaveCount(0);
});

test('profile shows real connection states, changes the theme, keeps support private and links to privacy', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:5173/') || request.method() !== 'GET') requests.push(request.url()); });
  await page.goto('/'); const dialog = await profile(page);
  await expect(dialog.getByText('Аккаунт ещё не создан', { exact: true })).toBeVisible();
  await expect(dialog.getByText(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Безопасность', exact: true }).click();
  await expect(dialog.getByText('Список пока недоступен', { exact: true })).toBeVisible();
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Доступ', exact: true }).click();
  await expect(dialog.getByText('Оплаченный доступ не проверяется', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Поддержка', exact: true }).click();
  await dialog.getByLabel('Тема обращения').fill('Вопрос по примеру'); await dialog.getByLabel('Сообщение', { exact: true }).fill('Синтетический черновик');
  await dialog.getByRole('button', { name: 'Очистить черновик', exact: true }).click();
  await expect(dialog.getByLabel('Сообщение', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Сообщение', { exact: true }).fill('Только в памяти');
  await dialog.getByLabel('Тема оформления').selectOption('dark'); await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Профиль', exact: true })).toBeFocused();
  await profile(page); await dialog.getByRole('button', { name: 'Поддержка', exact: true }).click();
  await expect(dialog.getByLabel('Сообщение', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Конфиденциальность', exact: true }).click();
  await expect(page).toHaveURL(/#settings\/privacy$/); await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Конфиденциальность', exact: true })).toBeVisible();
  expect(requests).toEqual([]); expect(await page.evaluate(() => ({keys:Object.keys(localStorage),session:sessionStorage.length,value:JSON.parse(localStorage.getItem('finance-appearance-v1')!)}))).toEqual({keys:['finance-appearance-v1'],session:0,value:{theme:'dark',density:'comfortable',textSize:'standard',motion:'system'}});
});

test('history links preserve financial filters, select the operation explicitly and do not create history', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Посмотреть пример', exact: true }).click();
  await page.getByRole('link', { name: 'Анализатор', exact: true }).click();
  await page.getByRole('button', { name: /^Сколько я потратил за выбранный период\?/ }).click();
  await page.getByRole('link', { name: 'Операции', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Поиск операций' }).fill('Перевод Дмитрию');
  await page.getByRole('button', { name: 'Перевод Дмитрию', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'История этой операции', exact: true }).click();
  await expect(page).toHaveURL(/#settings\/history$/);
  await expect(page.getByText('История операции:', { exact: false })).toContainText('Перевод Дмитрию');
  await expect(page.getByRole('heading', { name: 'История пока пуста' })).toBeVisible();
  await page.getByRole('button', { name: 'Показать всю историю', exact: true }).click();
  await expect(page.getByText('История операции:', { exact: false })).toHaveCount(0);
  await page.goBack(); await expect(page.getByRole('searchbox', { name: 'Поиск операций' })).toHaveValue('Перевод Дмитрию');
  await expect(page.getByTestId('operation-count')).toHaveText('Показано 1 из 1');
  await page.getByRole('button', { name: 'История изменений', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'История пока пуста' })).toBeVisible();
  await page.getByRole('link', { name: 'Анализатор', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('58 869 ₽');
});

test('closing the demo from profile clears the example but keeps appearance', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Посмотреть пример', exact: true }).click();
  const dialog = await profile(page); await dialog.getByLabel('Тема оформления').selectOption('dark');
  await dialog.getByRole('button', { name: 'Закрыть пример', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(page.getByTestId('expenses')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Начните с первой выписки' })).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await profile(page); await expect(dialog.getByRole('button', { name: 'Закрыть пример', exact: true })).toHaveCount(0);
});

test('both dialogs fit narrow screens and large text, escape restores focus without runtime errors', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#settings/interface'); await page.getByLabel('Размер текста', { exact: true }).selectOption('large'); await page.getByLabel('Тема', { exact: true }).selectOption('dark');
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 850 });
    const uploadDialog = await upload(page);
    await uploadDialog.getByLabel('Файлы выписок').setInputFiles({ ...statement, name: 'очень_длинное_синтетическое_имя_файла_без_личных_данных_для_проверки_переноса.pdf' });
    expect(await uploadDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Загрузить файлы', exact: true })).toBeFocused();
    const profileDialog = await profile(page); await profileDialog.getByRole('button', { name: 'Безопасность', exact: true }).click();
    expect(await profileDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Профиль', exact: true })).toBeFocused();
  }
  expect(errors).toEqual([]);
});
