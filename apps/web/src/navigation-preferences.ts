export type NavigationPreferences={startScreen:'overview'|'operations'|'analyzer'|'last';defaultPeriod:'all'|'current_month'|'last_30_days'|'current_year'};
export const defaultNavigationPreferences:NavigationPreferences={startScreen:'overview',defaultPeriod:'all'};
const key='finance-navigation-v1',lastKey='finance-last-screen-v1';
const mainScreens=['overview','operations','analyzer'] as const;
export function parseNavigationPreferences(value:unknown):NavigationPreferences{
 if(!value||typeof value!=='object'||Array.isArray(value))return {...defaultNavigationPreferences};
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['startScreen','defaultPeriod'].includes(k))||!['overview','operations','analyzer','last'].includes(String(v.startScreen))||!['all','current_month','last_30_days','current_year'].includes(String(v.defaultPeriod)))return {...defaultNavigationPreferences};
 return {startScreen:v.startScreen,defaultPeriod:v.defaultPeriod} as NavigationPreferences;
}
export function readNavigationPreferences(){try{return parseNavigationPreferences(JSON.parse(localStorage.getItem(key)??'null'));}catch{return {...defaultNavigationPreferences};}}
export function saveNavigationPreferences(value:NavigationPreferences){try{const v=parseNavigationPreferences(value);if(v.startScreen==='overview'&&v.defaultPeriod==='all'){localStorage.removeItem(key);localStorage.removeItem(lastKey);}else{localStorage.setItem(key,JSON.stringify(v));if(v.startScreen!=='last')localStorage.removeItem(lastKey);}}catch{/* Optional device preferences never block finance. */}}
export function resetNavigationPreferences(){try{localStorage.removeItem(key);localStorage.removeItem(lastKey);}catch{/* Memory state can still reset. */}}
export function rememberMainScreen(value:NavigationPreferences,screen:string){if(value.startScreen!=='last'||!mainScreens.includes(screen as typeof mainScreens[number]))return;try{localStorage.setItem(lastKey,screen);}catch{/* No financial values are persisted. */}}
export function initialFinanceHash(hash:string,value:NavigationPreferences,last?:string|null){
 if(/^#(?:overview|operations|analyzer|settings)(?:\/|$)/u.test(hash))return hash;
 let target=value.startScreen;
 if(target==='last'){if(last===undefined)try{last=localStorage.getItem(lastKey);}catch{/* Overview fallback. */}target=mainScreens.includes(last as typeof mainScreens[number])?last as typeof mainScreens[number]:'overview';}
 return '#'+target;
}
export function initialPeriod(value:NavigationPreferences['defaultPeriod'],now:Date,timezone:string):{from:string;through:string}{
 if(value==='all')return {from:'',through:''};
 const parts=new Intl.DateTimeFormat('en',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),p=(key:string)=>parts.find(v=>v.type===key)!.value,today=p('year')+'-'+p('month')+'-'+p('day');
 const from=value==='current_month'?today.slice(0,8)+'01':value==='current_year'?today.slice(0,4)+'-01-01':new Date(new Date(today+'T00:00:00Z').getTime()-29*86400000).toISOString().slice(0,10);
 return {from,through:today};
}
