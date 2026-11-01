import {defaultOverview,parseOverviewView} from '../../../packages/finance-core/src/overview';
import type {OverviewView} from './overview-client';
export const standardViewName='Стандартный обзор';
export const viewNameKey=(name:string)=>name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('ru');
/** Shared filters live in the workspace; widget-local filters remain in the view. */
export function sharedOverview(value:OverviewView):OverviewView{return {...parseOverviewView(value),filter:{},period:'all'};}
export function emptyOverview():OverviewView{return {...defaultOverview(),widgets:[],desktop:[],mobile:[]};}
export function copyViewName(name:string,names:string[]){const used=new Set(names.map(viewNameKey));for(let n=1;n<=101;n++){const suffix=n===1?' — копия':` — копия ${n}`,candidate=name.slice(0,160-suffix.length)+suffix;if(!used.has(viewNameKey(candidate)))return candidate;}return '';}
