import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
async function openExample(page:Page,section='requests') { await page.goto('/#'+section);await page.getByRole('button',{name:'Открыть пример',exact:true}).click(); }
async function openAnna(page:Page) { await page.getByRole('button',{name:'Открыть заявку Анна Смирнова'}).click(); }
async function confirm(page:Page) { await page.getByRole('button',{name:'Показать последствия'}).click();await expect(page.getByRole('region',{name:'Последствия решения'})).toBeVisible();await page.getByRole('button',{name:'Подтвердить решение в примере'}).click(); }
test('admin data is empty until opt-in, queue filters and browser navigation preserve the example',async({page})=>{
  await page.goto('/#requests');await expect(page.getByRole('heading',{name:'Админка готова для просмотра на примере'})).toBeVisible();
  await expect(page.getByRole('button',{name:/Открыть заявку/})).toHaveCount(0);
  await page.getByRole('button',{name:'Открыть пример',exact:true}).click();await expect(page.getByRole('button',{name:/Открыть заявку/})).toHaveCount(5);
  await page.getByRole('textbox',{name:'Поиск заявки'}).fill('банк б');await expect(page.getByRole('button',{name:/Открыть заявку/})).toHaveCount(1);
  await page.getByRole('textbox',{name:'Поиск заявки'}).fill('');await page.getByRole('combobox',{name:'Статус',exact:true}).selectOption('under_review');await expect(page.getByRole('button',{name:/Открыть заявку/})).toHaveCount(2);
  await page.getByRole('link',{name:'Продления',exact:true}).click();await expect(page.getByRole('heading',{name:'Продления подключим следующим блоком'})).toBeVisible();
  await page.goBack();await expect(page.getByRole('combobox',{name:'Статус',exact:true})).toHaveValue('under_review');
  await page.getByRole('button',{name:'Закрыть пример',exact:true}).click();await expect(page.getByRole('button',{name:'Открыть пример',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:/Открыть заявку/})).toHaveCount(0);
});
test('review shows a saved tariff, previews consequences and confirms exactly once without creating a registered account',async({page})=>{
  await openExample(page);await openAnna(page);
  const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Цена каталога сейчас: 1 190 ₽');await expect(dialog).toContainText('990 ₽');
  await page.getByRole('button',{name:'Показать последствия'}).click();
  await expect(page.getByRole('region',{name:'Последствия решения'})).toContainText('1 календарный месяц с активации');
  await page.getByRole('button',{name:'Назад к сверке'}).click();await expect(page.getByRole('textbox',{name:'Получено по этому переводу, ₽'})).toHaveValue('990,00');
  await confirm(page);await expect(dialog).toContainText('Оплачено — ожидает регистрации');await expect(dialog).toContainText('срок доступа ещё не отсчитывается');
  await expect(page.getByRole('button',{name:'Показать последствия'})).toHaveCount(0);
  await page.getByRole('button',{name:'Закрыть окно'}).click();await page.getByRole('link',{name:'Оплаты',exact:true}).click();
  await expect(page.getByText('2 записей',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Приглашения',exact:true}).click();await expect(page.getByText('2 записей',{exact:true})).toBeVisible();
  await expect(page.getByText('Письмо не отправлено',{exact:true})).toHaveCount(2);
});
test('underpayment requests a top-up, then records the second transfer separately',async({page})=>{
  await openExample(page);await openAnna(page);
  await page.getByRole('textbox',{name:'Получено по этому переводу, ₽'}).fill('500');
  await page.getByRole('radio',{name:'Запросить доплату',exact:true}).check();await page.getByRole('textbox',{name:'Причина решения / внутренняя заметка'}).fill('Нужна доплата 490 рублей');
  await confirm(page);await expect(page.getByRole('dialog')).toContainText('Ожидает доплаты');
  await expect(page.getByRole('textbox',{name:'Получено по этому переводу, ₽'})).toHaveValue('490,00');
  await confirm(page);await expect(page.getByRole('dialog')).toContainText('Оплачено — ожидает регистрации');
  await page.getByRole('button',{name:'Закрыть окно'}).click();await page.getByRole('link',{name:'Оплаты',exact:true}).click();
  await expect(page.getByText('3 записей',{exact:true})).toBeVisible();await expect(page.getByText('500 ₽',{exact:true})).toBeVisible();await expect(page.getByText('490 ₽',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'История действий',exact:true}).click();await expect(page.getByText('Запрошена доплата',{exact:true})).toBeVisible();
});
test('overpayment requires a separate choice and does not buy an extra month',async({page})=>{
  await openExample(page);await openAnna(page);await page.getByRole('textbox',{name:'Получено по этому переводу, ₽'}).fill('1200');
  await expect(page.getByRole('radio',{name:'Запросить доплату',exact:true})).toHaveCount(0);
  await page.getByRole('textbox',{name:'Причина решения / внутренняя заметка'}).fill('Полученная сумма принята за полный тариф');
  await page.getByRole('button',{name:'Показать последствия'}).click();await expect(page.getByRole('alert')).toContainText('Выберите решение');
  await page.getByRole('radio',{name:'Принять сумму за полный тариф',exact:true}).check();await confirm(page);
  await expect(page.getByRole('dialog')).toContainText('1 200 ₽ · 1 календарный месяц');
});
test('custom periods and rejection have explicit reasons and do not pretend to transfer a refund',async({page})=>{
  await openExample(page);await openAnna(page);await page.getByRole('textbox',{name:'Получено по этому переводу, ₽'}).fill('200');
  await page.getByRole('radio',{name:'Выдать отдельно согласованный период',exact:true}).check();await page.getByRole('spinbutton',{name:'Согласованный период, дней'}).fill('17');await page.getByRole('textbox',{name:'Причина решения / внутренняя заметка'}).fill('Согласован отдельный период');await confirm(page);
  await expect(page.getByRole('dialog')).toContainText('200 ₽ · 17 дней');await page.getByRole('button',{name:'Закрыть окно'}).click();
  await page.getByRole('button',{name:'Открыть заявку Иван Петров'}).click();await page.getByRole('textbox',{name:'Получено по этому переводу, ₽'}).fill('500');await page.getByRole('radio',{name:'Отклонить заявку / оформить возврат отдельно',exact:true}).check();await page.getByRole('textbox',{name:'Причина решения / внутренняя заметка'}).fill('Перевод возвращается вручную');await confirm(page);
  await expect(page.getByRole('dialog')).toContainText('Заявка закрыта');await page.getByRole('button',{name:'Закрыть окно'}).click();await page.getByRole('link',{name:'Оплаты',exact:true}).click();await expect(page.getByText('Требуется ручной возврат',{exact:true})).toBeVisible();
});
test('invitations can be cancelled/reissued with paid rights and old records retained',async({page})=>{
  await openExample(page,'invitations');await page.getByRole('button',{name:'Отменить',exact:true}).click();await page.getByRole('textbox',{name:'Причина',exact:true}).fill('Ссылка отменена по просьбе пользователя');await page.getByRole('button',{name:'Подтвердить в примере',exact:true}).click();await expect(page.getByText('Отменено',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Подготовить новое',exact:true}).click();await page.getByRole('textbox',{name:'Причина',exact:true}).fill('Нужна новая ссылка');await page.getByRole('button',{name:'Подтвердить в примере',exact:true}).click();
  await expect(page.getByText('2 записей',{exact:true})).toBeVisible();await expect(page.getByText('Отменено',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Подготовить новое',exact:true})).toHaveCount(1);
  await page.getByRole('link',{name:'Оплаты',exact:true}).click();await expect(page.getByText('1 записей',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'История действий',exact:true}).click();await expect(page.getByText('Приглашение отменено',{exact:true})).toBeVisible();await expect(page.getByText('Подготовлено новое приглашение',{exact:true})).toBeVisible();
});
test('admin stays on its own origin with no financial content, network writes, secrets or storage',async({page})=>{
  const writes:string[]=[],errors:string[]=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
  await openExample(page);await openAnna(page);await confirm(page);await page.getByRole('button',{name:'Закрыть окно'}).click();
  for(const section of ['Обзор','Оплаты','Приглашения','История действий'])await page.getByRole('link',{name:section,exact:true}).click();
  expect(new URL(page.url()).port).toBe('5174');expect(writes).toEqual([]);expect(errors).toEqual([]);
  expect(await page.evaluate(()=>Object.keys(localStorage).length+Object.keys(sessionStorage).length)).toBe(0);
  await expect(page.getByRole('link',{name:'Операции',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'Анализатор',exact:true})).toHaveCount(0);await expect(page.locator('input[type=password]')).toHaveCount(0);
});
test('cards, dialogs and themes fit 320/390/1024/1440 widths and Escape restores focus',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await openExample(page);await page.getByRole('button',{name:'Включить тёмную тему'}).click();
  for(const width of [320,390,1024,1440]){
    await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await openAnna(page);expect(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await page.keyboard.press('Tab');expect(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Открыть заявку Анна Смирнова'})).toBeFocused();
  }
  await openAnna(page);await page.getByRole('textbox',{name:'Получено по этому переводу, ₽'}).fill('1e3');await page.getByRole('button',{name:'Показать последствия'}).click();await expect(page.getByRole('alert')).toBeVisible();expect(errors).toEqual([]);
});
