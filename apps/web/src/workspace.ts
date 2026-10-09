import type {FinanceState} from './finance-client';
import type {Filter} from '../../../packages/finance-core/src/graph';
import type {Appearance} from './Settings';
import {defaultAppearance} from './Settings';
export type WorkspaceFilters={from:string;through:string;bankId:string;accountId:string;categoryIds:string[]};
export const allHistory:WorkspaceFilters={from:'',through:'',bankId:'',accountId:'',categoryIds:[]};
export function financialFilter(filters:WorkspaceFilters,accounts:FinanceState['accounts']):Filter{
 return {...(filters.from?{from:filters.from}:{}),...(filters.through?{through:filters.through}:{}),
  ...(filters.accountId?{accountIds:[filters.accountId]}:filters.bankId?{accountIds:accounts.filter(a=>a.bankId===filters.bankId).map(a=>a.id)}:{}),
  ...(filters.categoryIds.length?{categoryIds:filters.categoryIds}:{})};
}
export type FinanceRoute={screen:'overview'|'operations'|'analyzer'|'settings';section:string|null};
export const settingIds=['accounts','imports','categories','rules','counterparties','budgets','analytics','interface','privacy','history'] as const;
export function financeRoute(hash:string):FinanceRoute{
 const [screen,section]=hash.replace(/^#/,'').split('/');
 if(screen==='settings')return {screen,section:settingIds.includes(section as typeof settingIds[number])?section!:null};
 return {screen:screen==='operations'||screen==='analyzer'?screen:'overview',section:null};
}
const appearanceKey='finance-appearance-v1';
export function readAppearance():Appearance{
 try{const value=JSON.parse(localStorage.getItem(appearanceKey)??'null') as Partial<Appearance>|null;
  if(value&&['system','light','dark'].includes(value.theme??'')&&['comfortable','compact'].includes(value.density??'')&&['standard','large'].includes(value.textSize??'')&&['system','reduced','full'].includes(value.motion??''))return {theme:value.theme!,density:value.density!,textSize:value.textSize!,motion:value.motion!};
 }catch{/* Appearance is optional; a blocked or corrupt store never blocks finance. */}
 return {...defaultAppearance};
}
export function applyAppearance(value:Appearance){const root=document.documentElement;root.dataset.theme=value.theme;root.dataset.density=value.density;root.dataset.textSize=value.textSize;root.dataset.motion=value.motion;
 try{if(Object.entries(defaultAppearance).every(([key,v])=>value[key as keyof Appearance]===v))localStorage.removeItem(appearanceKey);else localStorage.setItem(appearanceKey,JSON.stringify({theme:value.theme,density:value.density,textSize:value.textSize,motion:value.motion}));}catch{/* Safe visual preferences can remain in memory. */}
}
