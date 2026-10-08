import type {Link} from './model.ts';

export function allocationParents(link:Link):string[]{return [...new Set([link.sourceAllocationId,link.targetAllocationId].filter((id):id is string=>!!id))];}

/** Iterative dependency order: no call-stack limit or input-order winner. */
export function allocationOrder(links:Link[]){
 const byId=new Map(links.map(l=>[l.id,l])),pending=new Map<string,number>(),children=new Map<string,string[]>(),order:Link[]=[];
 for(const l of links){const parents=allocationParents(l).filter(id=>byId.has(id));pending.set(l.id,parents.length);for(const id of parents){const list=children.get(id)??[];list.push(l.id);children.set(id,list);}}
 const ready=links.filter(l=>pending.get(l.id)===0).map(l=>l.id);
 for(let i=0;i<ready.length;i++){const id=ready[i]!;order.push(byId.get(id)!);for(const child of children.get(id)??[]){const n=pending.get(child)!-1;pending.set(child,n);if(n===0)ready.push(child);}}
 return {order,cyclic:links.filter(l=>pending.get(l.id)!>0).map(l=>l.id)};
}

/** Deletion follows every stored reference, including inactive/candidate descendants. */
export function dependentLinks(links:Link[],initial:Iterable<string>):string[]{
 const chosen=new Set(initial),children=new Map<string,string[]>();
 for(const l of links)for(const parent of allocationParents(l)){const list=children.get(parent)??[];list.push(l.id);children.set(parent,list);}
 const queue=[...chosen];for(let i=0;i<queue.length;i++)for(const id of children.get(queue[i]!)??[])if(!chosen.has(id)){chosen.add(id);queue.push(id);}
 return [...chosen].sort();
}
