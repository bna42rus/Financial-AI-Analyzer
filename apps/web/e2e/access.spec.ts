import { expect, test } from '@playwright/test';
test('access preview is opt-in, requires email before the payment step, and makes no deliveries or account changes',async({page})=>{
  const posts:string[]=[],errors:string[]=[];
  page.on('request',r=>{if(r.method()!=='GET')posts.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/#access');await expect(page.getByRole('heading',{name:'Начните с простой заявки'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Электронная почта'})).toHaveCount(0);
  await page.getByRole('button',{name:'Открыть пример заявки'}).click();
  await expect(page.getByText('Тестовый тариф',{exact:true})).toHaveCount(3);
  await page.getByRole('button',{name:'Выбрать на месяц',exact:true}).click();
  await page.getByRole('textbox',{name:'Имя',exact:true}).fill('Анна Смирнова');await page.getByRole('textbox',{name:'Электронная почта'}).fill('anna@example.test');
  await page.getByRole('button',{name:'Создать тестовую заявку'}).click();
  await expect(page.getByRole('heading',{name:'Сначала подтвердите почту'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Банк отправителя'})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:/пароль/i})).toHaveCount(0);
  await page.getByRole('button',{name:'Показать шаг после подтверждения'}).click();
  await expect(page.getByRole('heading',{name:'Оплата и данные отправителя'})).toBeVisible();
  await page.getByRole('textbox',{name:'Имя отправителя'}).fill('Анна Смирнова');await page.getByRole('textbox',{name:'Банк отправителя'}).fill('Банк А');
  await page.getByRole('button',{name:'Я оплатил — в примере'}).click();
  await expect(page.getByRole('heading',{name:'Следующий шаг — ручная сверка'})).toBeVisible();
  await expect(page.getByText('Доступ ещё не активирован.',{exact:false})).toBeVisible();
  expect(await page.evaluate(()=>Object.keys(localStorage).length+Object.keys(sessionStorage).length)).toBe(0);
  expect(posts).toEqual([]);expect(errors).toEqual([]);
  await page.getByRole('button',{name:'Закрыть пример',exact:true}).click();
  await expect(page.getByRole('button',{name:'Открыть пример заявки'})).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'Открыть пример заявки'})).toBeVisible();
});
test('access page works at narrow widths, retains the exact price and lets the visitor return to the app',async({page})=>{
  await page.goto('/#access');await page.getByRole('button',{name:'Открыть пример заявки'}).click();
  for(const width of [320,390,1024,1440]){
    await page.setViewportSize({width,height:850});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    const note=await page.getByText('Предварительный просмотр',{exact:true}).locator('..').boundingBox();expect(note!.width).toBeGreaterThan(170);
  }
  await page.getByRole('button',{name:'Выбрать на месяц',exact:true}).click();
  await expect(page.getByText('1 190 ₽',{exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Имя',exact:true}).fill('   ');await page.getByRole('textbox',{name:'Электронная почта'}).fill('test@example.test');
  await page.getByRole('button',{name:'Создать тестовую заявку'}).click();await expect(page.getByRole('alert')).toContainText('обязательные поля');
  await page.getByRole('link',{name:'К экранам приложения'}).click();await expect(page.getByRole('heading',{name:'Обзор',exact:true})).toBeVisible();
});
