import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {PointerEvent,ReactNode,CSSProperties} from 'react';
import {GripVertical,Maximize2} from 'lucide-react';
import type {LayoutItem} from '../../../packages/finance-core/src/overview';
import {layoutLimits,packOverview,pinLayout} from './overview-layout';
import type {Placement} from './overview-layout';
import styles from './Overview.module.css';
type Gesture={id:string;kind:'move'|'resize';x:number;y:number;scrollY:number;base:Placement;candidate:Placement;items:LayoutItem[]};
export function OverviewCanvas({items,device,disabled,names,onChange,children}:{items:LayoutItem[];device:'desktop'|'mobile';disabled:boolean;names:Map<string,string>;onChange:(items:LayoutItem[])=>void;children:(item:LayoutItem)=>ReactNode}){
 const root=useRef<HTMLDivElement>(null),[container,setContainer]=useState(1),[heights,setHeights]=useState<Record<string,number>>({}),[preview,setPreview]=useState<LayoutItem[]|null>(null),[drag,setDrag]=useState<{id:string;p:Placement}|null>(null),[message,setMessage]=useState('');
 const gesture=useRef<Gesture|null>(null),current=useRef({disabled,onChange});current.current={disabled,onChange};
 useEffect(()=>{gesture.current=null;setDrag(null);setPreview(null);},[disabled,device,container]);
 useLayoutEffect(()=>{const el=root.current;if(!el)return;const measure=()=>{setContainer(el.clientWidth);if(gesture.current)return;const next:Record<string,number>={};el.querySelectorAll<HTMLElement>('[data-canvas-body]').forEach(n=>{const id=n.dataset.canvasBody!;next[id]=Math.ceil(n.offsetHeight);next[id+':expanded']=n.querySelector('details[open]')?1:0;});setHeights(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);};const observer=new ResizeObserver(measure);observer.observe(el);el.querySelectorAll('[data-canvas-body]').forEach(n=>observer.observe(n));el.addEventListener('toggle',measure,true);measure();return()=>{observer.disconnect();el.removeEventListener('toggle',measure,true);};},[items.map(i=>i.id+':'+i.hidden).join('|'),device]);
 const placements=packOverview(preview??items,container,device,heights),positions=new Map(placements.map(p=>[p.id,p]));
 function start(e:PointerEvent<HTMLButtonElement>,item:LayoutItem,kind:'move'|'resize'){
  if(disabled||e.button!==0)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);const p=positions.get(item.id)!;gesture.current={id:item.id,kind,x:e.clientX,y:e.clientY,scrollY:window.scrollY,base:p,candidate:p,items};setDrag({id:item.id,p});
 }
 function move(e:PointerEvent<HTMLButtonElement>){const g=gesture.current;if(!g||current.current.disabled)return;const dx=e.clientX-g.x,dy=e.clientY-g.y+window.scrollY-g.scrollY;
  let next=device==='mobile'?g.items.map(i=>({...i,width:1 as const,widthPercent:100})):pinLayout(g.items,placements,container);
  if(g.kind==='resize'){
   const full=device==='mobile'||g.base.width+dx>container*.75,height=Math.max(layoutLimits.minimumHeight,Math.min(layoutLimits.maximumHeight,Math.round(g.base.height+dy)));
   next=next.map(i=>i.id===g.id?{...i,width:device==='mobile'?1:full?2:1,widthPercent:full?100:50,heightPx:height}:i);
   const p=packOverview(next,container,device,{}).find(p=>p.id===g.id)!;g.candidate=p;setDrag({id:g.id,p});
  }else{
   g.candidate={...g.base,x:device==='mobile'?0:Math.max(0,Math.min(container-g.base.width,g.base.x+dx)),y:Math.max(0,g.base.y+dy)};
   const rect=root.current!.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
   const target=packOverview(g.items,container,device,heights).find(p=>p.id!==g.id&&x>=p.x&&x<=p.x+p.width&&y>=p.y&&y<=p.y+p.height);
   if(target){const a=next.findIndex(i=>i.id===g.id),b=next.findIndex(i=>i.id===target.id);[next[a],next[b]]=[next[b]!,next[a]!];}
   setDrag({id:g.id,p:g.candidate});
  }
  setPreview(next);
 }
 function finish(cancel=false){const g=gesture.current;gesture.current=null;setDrag(null);setPreview(null);if(!g||cancel||current.current.disabled)return;if(preview&&JSON.stringify(preview)!==JSON.stringify(items))onChange(preview);setMessage((g.kind==='move'?'Виджет перемещён: ':'Размер изменён: ')+names.get(g.id));}
 function keyboard(e:React.KeyboardEvent<HTMLButtonElement>,item:LayoutItem,kind:'move'|'resize'){
  if(e.key==='Escape'){finish(true);return;}if(!e.key.startsWith('Arrow'))return;e.preventDefault();const next=device==='mobile'?items.map(i=>({...i,width:1 as const,widthPercent:100})):pinLayout(items,placements,container),index=next.findIndex(i=>i.id===item.id);
  if(kind==='move'){const to=index+(['ArrowUp','ArrowLeft'].includes(e.key)?-1:1);if(to<0||to>=next.length)return;[next[index],next[to]]=[next[to]!,next[index]!];}
  else{if(device==='mobile'&&['ArrowLeft','ArrowRight'].includes(e.key))return;const p=positions.get(item.id)!;next[index]={...next[index]!,...(['ArrowLeft','ArrowRight'].includes(e.key)?{width:e.key==='ArrowRight'?2:1,widthPercent:e.key==='ArrowRight'?100:50}:{heightPx:Math.min(1600,Math.max(240,p.height+(e.key==='ArrowUp'?-16:16)))})};}
  onChange(next);
 }
 const height=Math.max(0,...placements.map(p=>p.y+p.height),drag?drag.p.y+drag.p.height:0);
 return <><p className={styles.srOnly} role="status">{message}</p><div ref={root} className={styles.canvas} style={{height}} aria-label="Виджеты обзора">{items.filter(i=>!i.hidden).map(item=>{const stored=positions.get(item.id)!,active=drag?.id===item.id,p=active?drag.p:stored,sized=item.heightPx!==undefined||active&&gesture.current?.kind==='resize',style:CSSProperties={width:p.width,transform:`translate(${p.x}px, ${p.y}px)`,...(sized?{'--widget-height':(preview?.find(i=>i.id===item.id)?.heightPx??item.heightPx??p.height)+'px'} as CSSProperties:{})};return <div key={item.id} data-widget-id={item.id} data-dragging={active||undefined} data-custom-size={sized||undefined} className={styles.canvasCell} style={style}><div data-canvas-body={item.id} className={styles.canvasBody}><div className={styles.canvasHandle}><button type="button" disabled={disabled} title="Перетащить виджет; стрелки меняют порядок" aria-label={'Переместить виджет: '+names.get(item.id)} onPointerDown={e=>start(e,item,'move')} onPointerMove={move} onPointerUp={()=>finish()} onPointerCancel={()=>finish(true)} onKeyDown={e=>keyboard(e,item,'move')}><GripVertical size={17}/></button></div>{children(item)}{<button className={styles.resizeHandle} type="button" disabled={disabled} title={device==='mobile'?'Изменить высоту':'Изменить ширину и высоту'} aria-label={'Изменить размер виджета: '+names.get(item.id)} onPointerDown={e=>start(e,item,'resize')} onPointerMove={move} onPointerUp={()=>finish()} onPointerCancel={()=>finish(true)} onKeyDown={e=>keyboard(e,item,'resize')}><Maximize2 size={15}/></button>}</div></div>;})}</div></>;
}
