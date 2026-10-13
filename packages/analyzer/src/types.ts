import type {ActionTool} from './actions.ts';
import type {Query} from './registry.ts';
import type {Widget,WidgetResult} from '../../finance-core/src/overview.ts';
export type Quota={available:boolean;limit:number|null;used:number;remaining:number|null;periodStart:string|null;resetAt:string|null;warning:80|95|100|null;reserved?:number};
export type Answer={text:string;mode:'deterministic'|'test_adapter'|'ai'|'unavailable'|'clarification'|'redirect';registryVersion:string;query?:Query;result?:WidgetResult;widget?:Widget;generation?:string;revision?:string;accountCount?:number;actionOperationCount?:number;periodFromQuestion?:boolean;followUp?:boolean;computedAt?:string;provider?:{id:string;model:string;version:string};};
export type Message={id:string;question:string;answer:Answer;createdAt:string;actionId:string|null;outcome?:{status:string;undone?:boolean;tool?:ActionTool;confirmation?:boolean;result?:{status:string;actionId:string}}};
export type Chat={matches?:boolean;id:string;title:string;pinned:boolean;createdAt:string;modifiedAt:string;messages:Message[]};
export type AnalyzerState={chats:Chat[];quota:Quota;providerAvailable:boolean;registryVersion:string};

