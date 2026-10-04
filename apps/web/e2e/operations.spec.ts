import { expect,test } from '@playwright/test';

async function openExample(page:import('@playwright/test').Page){await page.goto('/#operations');await page.getByRole('button',{name:'Посмотреть пример',exact:true}).click();await expect(page.getByTestId('operation-count')).toHaveText('Показано 18 из 18');}

test('empty entry, search and no-match state are distinct',async({page})=>{
  await page.goto('/#operations');await expect(page.getByRole('heading',{name:'Здесь будут ваши операции'})).toBeVisible();await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('button',{name:'Посмотреть пример',exact:true}).click();await expect(page.getByTestId('operation-expenses')).toHaveText('58 869 ₽');
  await page.getByRole('searchbox',{name:'Поиск операций'}).fill('ЗАРПЛАТА');await expect(page.getByTestId('operation-count')).toHaveText('Показано 1 из 1');await expect(page.getByTestId('operation-income')).toHaveText('120 000 ₽');await expect(page.getByTestId('operation-expenses')).toHaveText('0 ₽');
  await page.getByRole('searchbox').fill('не существующая операция');await expect(page.getByRole('heading',{name:'Ничего не найдено'})).toBeVisible();await page.getByRole('searchbox').fill('');await expect(page.getByTestId('operation-count')).toHaveText('Показано 18 из 18');
});

test('quick filters show correct totals and card accounting explanation',async({page})=>{
  await openExample(page);await page.getByRole('button',{name:'Требуют внимания 2',exact:true}).click();await expect(page.getByTestId('operation-count')).toHaveText('Показано 2 из 2');await expect(page.getByTestId('operation-expenses')).toHaveText('1 200 ₽');
  await page.getByRole('button',{name:'Смысл не определён 1',exact:true}).click();await expect(page.getByTestId('operation-expenses')).toHaveText('0 ₽');await page.getByRole('button',{name:'Перевод Дмитрию',exact:true}).click();await expect(page.getByRole('dialog').getByText('Не определено, для чего сделан перевод. Пока он не учитывается в расходах и доходах.')).toBeVisible();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Исключено 1',exact:true}).click();await expect(page.getByTestId('operation-expenses')).toHaveText('0 ₽');await page.getByRole('button',{name:'Онлайн-кинотеатр',exact:true}).click();await expect(page.getByRole('dialog').getByText('Исключена',{exact:true})).toBeVisible();
});

test('global and advanced filters work on desktop and mobile sheet',async({page},testInfo)=>{
  await openExample(page);
  const mobile=testInfo.project.name==='mobile';if(mobile)await page.getByRole('button',{name:'Фильтры',exact:true}).click();
  const surface=mobile?page.getByRole('dialog'):page;
  await surface.getByRole('combobox',{name:'Банк',exact:true}).selectOption('Сбер');await surface.getByRole('combobox',{name:'Финансовый смысл',exact:true}).selectOption('expense');
  await surface.getByLabel('С даты',{exact:true}).fill('2026-10-01');await expect(page.getByRole('alert')).toBeVisible();
  await surface.getByLabel('С даты',{exact:true}).fill('2026-09-01');
  if(mobile)await surface.getByRole('button',{name:'Показать операции',exact:true}).click();await expect(page.getByTestId('operation-count')).toHaveText('Показано 2 из 2');await expect(page.getByTestId('operation-expenses')).toHaveText('32 199 ₽');
  await page.getByRole('link',{name:'Обзор',exact:true}).click();await expect(page.getByTestId('expenses')).toHaveText('32 199 ₽');
});

test('select all means all matches; filter changes remove stale selection',async({page})=>{
  await openExample(page);await page.getByRole('searchbox').fill('перекресток');await expect(page.getByTestId('operation-count')).toHaveText('Показано 2 из 2');
  await page.getByRole('checkbox',{name:'Выбрать все найденные',exact:true}).check();await expect(page.getByRole('status')).toContainText('Выбрано: 2');
  await page.getByRole('searchbox').fill('Зарплата');await expect(page.getByRole('status')).toHaveCount(0);
  await page.getByRole('button',{name:'Зарплата',exact:true}).focus();await page.keyboard.press('Control+a');await expect(page.getByRole('status')).toContainText('Выбрано: 1');
});

test('overview drilldown keeps context and the card returns focus to the same operation',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Посмотреть пример',exact:true}).click();await page.getByRole('button',{name:'Жильё 32 000 ₽',exact:true}).click();await expect(page.getByRole('heading',{name:'Операции',exact:true})).toBeVisible();await expect(page.getByTestId('operation-count')).toHaveText('Показано 1 из 1');await expect(page.getByText('Из Обзора: Жильё')).toBeVisible();
  const operation=page.getByRole('button',{name:'Александр · аренда',exact:true});await operation.click();await expect(page.getByRole('dialog').getByRole('heading',{name:'Александр · аренда'})).toBeVisible();await page.getByRole('dialog').getByText('Данные примера',{exact:true}).click();await expect(page.getByRole('dialog').getByText('2026-09-01',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(operation).toBeFocused();await expect(page.getByTestId('operation-count')).toHaveText('Показано 1 из 1');
});

test('sort, range selection, card layout and reload do not leak or overflow',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await openExample(page);
  await page.getByRole('combobox',{name:'Сортировка',exact:true}).selectOption('date-asc');await page.getByRole('button',{name:'Александр · аренда',exact:true}).focus();await page.keyboard.press(' ');await page.keyboard.press('Shift+ArrowDown');await expect(page.getByRole('status')).toContainText('Выбрано: 2');
  await page.getByRole('button',{name:'Александр · аренда',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.keyboard.press('Escape');
  expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});expect(errors).toEqual([]);await page.reload();await expect(page.getByRole('heading',{name:'Здесь будут ваши операции'})).toBeVisible();
});
