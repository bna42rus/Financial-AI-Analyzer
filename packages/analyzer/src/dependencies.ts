/** Linear transitive closure. Linked facts can contribute outside a visible
 * period, so invalidation must retain every connected operation. */
export function connectedDependencies(ids:Iterable<string>,links:Iterable<{source_id:string;target_id:string}>):string[]{
 const adjacent=new Map<string,string[]>();
 for(const {source_id:a,target_id:b}of links){const x=adjacent.get(a)??[];x.push(b);adjacent.set(a,x);const y=adjacent.get(b)??[];y.push(a);adjacent.set(b,y);}
 const seen=new Set(ids),queue=[...seen];for(let i=0;i<queue.length;i++)for(const id of adjacent.get(queue[i]!)??[])if(!seen.has(id)){seen.add(id);queue.push(id);}
 return queue;
}
