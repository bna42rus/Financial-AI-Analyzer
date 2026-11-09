import {expect,type Locator} from '@playwright/test';

export async function chooseOption(trigger:Locator,value:string|RegExp){
 await trigger.click();
 const menu=trigger.page().locator('[data-choice-picker]');
 await expect(menu).toBeVisible();
 const choice=typeof value==='string'?menu.locator('[data-choice-option='+JSON.stringify(value)+']'):menu.getByRole('radio',{name:value});
 const selected=await choice.getAttribute('data-choice-option');
 await choice.click();
 await expect(menu).toBeHidden();
 return selected;
}
