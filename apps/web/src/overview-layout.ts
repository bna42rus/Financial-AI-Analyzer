import type {LayoutItem} from '../../../packages/finance-core/src/overview';
export const layoutLimits={minimumWidth:280,minimumHeight:240,maximumHeight:1600,minimumPercent:20,gap:16};
export function layoutWidth(item:LayoutItem,device:'desktop'|'mobile'){return item.widthPercent??(device==='mobile'||item.width===2?100:50);}
export type Placement={id:string;x:number;y:number;width:number;height:number};
/** Dense independent card placement. Pixel geometry never changes financial facts or stored order. */
export function packOverview(items:LayoutItem[],container:number,device:'desktop'|'mobile',heights:Record<string,number>):Placement[]{
 const width=Math.max(1,container),gap=layoutLimits.gap,placed:Placement[]=[];
 for(const item of items.filter(i=>!i.hidden)){
  const desired=(width+gap)*layoutWidth(item,device)/100-gap,w=Math.min(width,Math.max(Math.min(layoutLimits.minimumWidth,width),desired)),height=item.heightPx??heights[item.id]??(item.size==='compact'?320:item.size==='tall'?620:450);
  const candidates=[0,...placed.map(p=>p.x+p.width+gap)].filter(x=>x+w<=width+.5);let best={x:0,y:Infinity};
  for(const x of candidates){const overlap=placed.filter(p=>x<p.x+p.width+gap-.5&&x+w+gap>p.x+.5),y=overlap.reduce((n,p)=>Math.max(n,p.y+p.height+gap),0);if(y<best.y||y===best.y&&x<best.x)best={x,y};}
  placed.push({id:item.id,...best,width:w,height});
 }
 return placed;
}
