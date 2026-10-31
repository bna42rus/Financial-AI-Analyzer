import {test,expect} from 'vitest';
import {unifiedWidgetCategories} from './widget-category-filter';
const categories=[{id:'root',parentId:null},{id:'other',parentId:null},{id:'leaf',parentId:'root'}] as any;
test('old root and leaf intersection becomes one exact leaf selection',()=>{expect(unifiedWidgetCategories({categoryIds:['root'],subcategoryIds:['leaf'],search:'shop'},categories)).toEqual({categoryIds:['leaf'],search:'shop'});expect(unifiedWidgetCategories({subcategoryIds:['leaf']},categories)).toEqual({categoryIds:['leaf']});});
test('contradictory old choices remain empty rather than broadening to a sibling or root',()=>{expect(unifiedWidgetCategories({categoryIds:['other'],subcategoryIds:['leaf']},categories)).toEqual({categoryIds:[]});expect(unifiedWidgetCategories({subcategoryIds:['root']},categories)).toEqual({categoryIds:[]});});
test('deleted references remain visible and rejected rather than silently removed',()=>{const original={categoryIds:['missing'],subcategoryIds:['leaf']};expect(unifiedWidgetCategories(original,categories)).toBe(original);});
