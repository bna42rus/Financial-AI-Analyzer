import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {PointerEvent,ReactNode,CSSProperties} from 'react';
import {GripVertical,Maximize2} from 'lucide-react';
import type {LayoutItem} from '../../../packages/finance-core/src/overview';
import {layoutLimits,packOverview,pinLayout,overlaps} from './overview-layout';
import type {Placement} from './overview-layout';
import styles from './Overview.module.css';
type Gesture={id:string;kind:'move'|'resize';x:number;y:number;scrollY:number;base:Placement;candidate:Placement;valid:boolean;target:string|null;placements:Placement[]};
export function OverviewCanvas({items,device,disabled,names,onChange,children}:{items:LayoutItem[];device:'desktop'|'mobile';disabled:boolean;names:Map<string,string>;onChange:(items:LayoutItem[])=>void;children:(item:LayoutItem)=>ReactNode}){
 const root=useRef<HTMLDivElement>(null),[container,setContainer]=useState(1),[heights,setHeights]=useState<Record<string,number>>({}),[drag,setDrag]=useState<{id:string;p:Placement;valid:boolean}|null>(null),[message,setMessage]=useState('');
 const gesture=useRef<Gesture|null>(null),current=useRef({items,disabled,onChange});current.current={items,disabled,onChange};
 useEffect(()=>{gesture.current=null;setDrag(null);},[disabled,device]);
 useLayoutEffect(()=>{const el=root.current;if(!el)return;const measure=()=>{setContainer(el.clientWidth);if(gesture.current)return;const next:Record<string,number>={};el.querySelectorAll<HTMLElement>('[data-canvas-body]').forEach(n=>{next[n.dataset.canvasBody!]=Math.ceil(n.offsetHeight);});setHeights(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);};const observer=new ResizeObserver(measure);observer.observe(el);el.querySelectorAll('[data-canvas-body]').forEach(n=>observer.observe(n));measure();return()=>observer.disconnect();},[items.map(i=>i.id+':'+i.hidden).join('|'),device]);
 useEffect(()=>{gesture.current=null;setDrag(null);},[container]);
 const placements=packOverview(items,container,device,heights),positions=new Map(placements.map(p=>[p.id,p]));
 function start(e:PointerEvent<HTMLButtonElement>,item:LayoutItem,kind:'move'|'resize'){
  if(disabled||e.button!==0||device==='mobile'&&kind==='resize')return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);const p=positions.get(item.id)!;gesture.current={id:item.id,kind,x:e.clientX,y:e.clientY,scrollY:window.scrollY,base:p,candidate:p,valid:true,target:null,placements};setDrag({id:item.id,p,valid:true});
 }
 function move(e:PointerEvent<HTMLButtonElement>){const g=gesture.current;if(!g||current.current.disabled)return;const dx=e.clientX-g.x,dy=e.clientY-g.y+window.scrollY-g.scrollY;
  if(device==='mobile'){
   g.candidate={...g.base,y:Math.max(0,g.base.y+dy)};const pointer=e.clientY-(root.current?.getBoundingClientRect().top??0);g.target=g.placements.find(p=>p.id!==g.id&&pointer>=p.y&&pointer<=p.y+p.height)?.id??null;
  }else if(g.kind==='move')g.candidate={...g.base,x:Math.max(0,Math.min(container-g.base.width,g.base.x+dx)),y:Math.max(0,Math.min(1000000,g.base.y+dy))};
  else g.candidate={...g.base,width:Math.min(container-g.base.x,Math.max(Math.min(layoutLimits.minimumWidth,container),g.base.width+dx)),height:Math.min(1600,Math.max(240,g.base.height+dy))};
  g.valid=device==='mobile'||!g.placements.some(p=>p.id!==g.id&&overlaps(g.candidate,p));setDrag({id:g.id,p:g.candidate,valid:g.valid});
 }
 function finish(cancel=false){const g=gesture.current;gesture.current=null;setDrag(null);if(!g||cancel||current.current.disabled)return;if(!g.valid){setMessage('Здесь другой виджет. Выберите свободное место.');return;}
  if(device==='mobile'){if(!g.target||Math.abs(g.candidate.y-g.base.y)<8)return;const next=[...items],from=next.findIndex(i=>i.id===g.id),to=next.findIndex(i=>i.id===g.target),[item]=next.splice(from,1);next.splice(to,0,item!);onChange(next);}
  else{const p=g.candidate;if(Math.abs(p.x-g.base.x)+Math.abs(p.y-g.base.y)+Math.abs(p.width-g.base.width)+Math.abs(p.height-g.base.height)<1)return;const pinned=pinLayout(items,g.placements,container);onChange(pinned.map(i=>i.id===g.id?{...i,xPercent:p.x/container*100,y:Math.round(p.y),...(g.kind==='resize'?{widthPercent:(p.width+16)/(container+16)*100,heightPx:Math.round(p.height)}:{})}:i));}
  setMessage((g.kind==='move'?'Виджет перемещён: ':'Размер изменён: ')+names.get(g.id));
 }
 function keyboard(e:React.KeyboardEvent<HTMLButtonElement>,item:LayoutItem,kind:'move'|'resize'){
  if(e.key==='Escape'){finish(true);return;}if(!e.key.startsWith('Arrow'))return;e.preventDefault();if(device==='mobile'){const next=[...items],index=next.findIndex(i=>i.id===item.id),to=index+(e.key==='ArrowUp'?-1:e.key==='ArrowDown'?1:0);if(to<0||to>=next.length||to===index)return;const [i]=next.splice(index,1);next.splice(to,0,i!);onChange(next);return;}
  const p=positions.get(item.id)!,dx=e.key==='ArrowLeft'?-16:e.key==='ArrowRight'?16:0,dy=e.key==='ArrowUp'?-16:e.key==='ArrowDown'?16:0,candidate=kind==='move'?{...p,x:Math.max(0,Math.min(container-p.width,p.x+dx)),y:Math.max(0,p.y+dy)}:{...p,width:Math.min(container-p.x,Math.max(Math.min(180,container),p.width+dx)),height:Math.max(240,Math.min(1600,p.height+dy))};
  if(placements.some(other=>other.id!==p.id&&overlaps(candidate,other))){setMessage('Здесь другой виджет.');return;}onChange(pinLayout(items,placements,container).map(i=>i.id===item.id?{...i,xPercent:candidate.x/container*100,y:candidate.y,...(kind==='resize'?{widthPercent:(candidate.width+16)/(container+16)*100,heightPx:candidate.height}:{})}:i));
 }
 const height=Math.max(0,...placements.map(p=>p.y+p.height),drag?drag.p.y+drag.p.height:0);
 return <><p className={styles.srOnly} role="status">{message}</p><div ref={root} className={styles.canvas} style={{height}} aria-label="Виджеты обзора">{items.filter(i=>!i.hidden).map(item=>{const stored=positions.get(item.id)!,active=drag?.id===item.id,p=active?drag.p:stored,sized=device==='desktop'&&(item.heightPx!==undefined||active&&gesture.current?.kind==='resize'),style:CSSProperties={width:p.width,transform:`translate(${p.x}px, ${p.y}px)`,...(sized?{'--widget-height':p.height+'px'} as CSSProperties:{})};return <div key={item.id} data-widget-id={item.id} data-dragging={active||undefined} data-invalid-drop={active&&!drag.valid||undefined} data-custom-size={sized||undefined} className={styles.canvasCell} style={style}><div data-canvas-body={item.id} className={styles.canvasBody}><div className={styles.canvasHandle}><button type="button" disabled={disabled} title="Перетащить виджет; стрелки перемещают его" aria-label={'Переместить виджет: '+names.get(item.id)} onPointerDown={e=>start(e,item,'move')} onPointerMove={move} onPointerUp={()=>finish()} onPointerCancel={()=>finish(true)} onKeyDown={e=>keyboard(e,item,'move')}><GripVertical size={17}/></button></div>{children(item)}{device==='desktop'&&<button className={styles.resizeHandle} type="button" disabled={disabled} title="Изменить размер" aria-label={'Изменить размер виджета: '+names.get(item.id)} onPointerDown={e=>start(e,item,'resize')} onPointerMove={move} onPointerUp={()=>finish()} onPointerCancel={()=>finish(true)} onKeyDown={e=>keyboard(e,item,'resize')}><Maximize2 size={15}/></button>}</div></div>;})}</div></>;
}
