import type {LayoutItem} from '../../../packages/finance-core/src/overview';
export const layoutLimits={minimumWidth:180,minimumHeight:240,maximumHeight:1600,minimumPercent:1,gap:16};
export function layoutWidth(item:LayoutItem,device:'desktop'|'mobile'){return device==='mobile'?100:item.widthPercent??(item.width===2?100:50);}
export type Placement={id:string;x:number;y:number;width:number;height:number};
export const overlaps=(a:Placement,b:Placement,gap=0)=>a.x<b.x+b.width+gap-.5&&a.x+a.width+gap>b.x+.5&&a.y<b.y+b.height+gap-.5&&a.y+a.height+gap>b.y+.5;
export function packOverview(items:LayoutItem[],container:number,device:'desktop'|'mobile',heights:Record<string,number>):Placement[]{
 const width=Math.max(1,container),gap=layoutLimits.gap,placed:Placement[]=[];
 for(const item of items.filter(i=>!i.hidden)){
  const desired=(width+gap)*layoutWidth(item,device)/100-gap,w=device==='mobile'?width:Math.min(width,Math.max(Math.min(layoutLimits.minimumWidth,width),desired));
  const height=device==='mobile'?(heights[item.id]??450):(item.heightPx??heights[item.id]??(item.size==='compact'?320:item.size==='tall'?620:450));
  const wanted={id:item.id,x:device==='desktop'?Math.min(width-w,Math.max(0,(item.xPercent??0)/100*width)):0,y:device==='desktop'?item.y??0:0,width:w,height};
  if(device==='desktop'&&item.xPercent!==undefined&&item.y!==undefined&&!placed.some(p=>overlaps(wanted,p))){placed.push(wanted);continue;}
  const candidates=[0,...placed.map(p=>p.x+p.width+gap)].filter(x=>x+w<=width+.5);let best={x:0,y:Infinity};
  for(const x of candidates){let y=item.y!==undefined&&device==='desktop'?item.y:0;let collision:Placement|undefined;while((collision=placed.find(p=>overlaps({id:item.id,x,y,width:w,height},p,gap))))y=collision.y+collision.height+gap;if(y<best.y||y===best.y&&x<best.x)best={x,y};}
  placed.push({id:item.id,...best,width:w,height});
 }
 return placed;
}
export function pinLayout(items:LayoutItem[],placements:Placement[],container:number){const byId=new Map(placements.map(p=>[p.id,p]));return items.map(i=>{const p=byId.get(i.id);return p?{...i,xPercent:p.x/container*100,y:p.y}:i;});}
