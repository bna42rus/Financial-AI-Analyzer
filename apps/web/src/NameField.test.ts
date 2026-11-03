import {test,expect} from 'vitest';
import {nameRefresh} from './NameField';
test('refresh preserves an unsaved name and requires an explicit conflict decision',()=>{
 const original={value:'Мой новый счёт',baseline:'Счёт',conflict:false};
 const next=nameRefresh(original,'Счёт на другом устройстве');
 expect(next).toEqual({value:'Мой новый счёт',baseline:'Счёт на другом устройстве',conflict:true});
 expect(nameRefresh(next,'Счёт на другом устройстве')).toEqual(next);
 expect(original).toEqual({value:'Мой новый счёт',baseline:'Счёт',conflict:false});
});
test('a clean field follows refresh and an acknowledged own save becomes clean',()=>{
 expect(nameRefresh({value:'Счёт',baseline:'Счёт',conflict:false},'Другой')).toEqual({value:'Другой',baseline:'Другой',conflict:false});
 expect(nameRefresh({value:'Мой',baseline:'Счёт',conflict:false},'Мой')).toEqual({value:'Мой',baseline:'Мой',conflict:false});
});
