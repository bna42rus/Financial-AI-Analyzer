import type {LayoutItem} from '../../../packages/finance-core/src/overview';
export const layoutLimits={minimumWidth:180,minimumHeight:240,maximumHeight:1600,minimumPercent:50,gap:16};
export function layoutWidth(item:LayoutItem,device:'desktop'|'mobile'){return device==='mobile'?100:(item.widthPercent??(item.width===2?100:50))>=75?100:50;}
export type Placement={id:string;x:number;y:number;width:number;height:number};
export const overlaps=(a:Placement,b:Placement,gap=0)=>a.x<b.x+b.width+gap-.5&&a.x+a.width+gap>b.x+.5&&a.y<b.y+b.height+gap-.5&&a.y+a.height+gap>b.y+.5;
/** Ordered two-column masonry; old free coordinates are retained in storage but
 * never pin a card or prevent its neighbours from flowing around a resize. */
export function packOverview(items:LayoutItem[],container:number,device:'desktop'|'mobile',heights:Record<string,number>):Placement[]{
 const width=Math.max(1,container),gap=layoutLimits.gap,columns=[0,0],out:Placement[]=[];
 for(const item of items.filter(i=>!i.hidden)){
  const full=device==='mobile'||width<2*layoutLimits.minimumWidth+gap||layoutWidth(item,device)===100;
  const fallback=item.size==='compact'?320:item.size==='tall'?620:450;
  const base=item.heightPx??heights[item.id]??fallback;
  const height=device==='mobile'?(heights[item.id]??fallback):Math.max(layoutLimits.minimumHeight,base,heights[item.id+':expanded']?heights[item.id]??0:0);
  const column=full?0:columns[0]!<=columns[1]!?0:1,y=full?Math.max(...columns):columns[column]!,w=full?width:(width-gap)/2;
  out.push({id:item.id,x:column*(w+gap),y,width:w,height});
  if(full)columns[0]=columns[1]=y+height+gap;else columns[column]=y+height+gap;
 }
 return out;
}
export function pinLayout(items:LayoutItem[],_placements:Placement[],_container:number){return items.map(({xPercent:_x,y:_y,...i})=>({...i,width:layoutWidth(i,'desktop')===100?2 as const:1 as const,widthPercent:layoutWidth(i,'desktop')}));}
