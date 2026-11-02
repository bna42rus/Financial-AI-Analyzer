import {useEffect,useId,useRef,useState} from 'react';
import type {InputHTMLAttributes} from 'react';
import {CalendarDays} from 'lucide-react';
import styles from './DateInput.module.css';
const display=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)?value.split('-').reverse().join('.'):value;
export function dateFromText(text:string):string|null{
 const match=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);if(!match)return null;const iso=match[3]+'-'+match[2]+'-'+match[1],date=new Date(iso+'T00:00:00Z');return match[3]!=='0000'&&Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso?iso:null;
}
export function dateText(text:string){
 if(/^\d{4}-\d{2}-\d{2}$/.test(text))return display(text);const digits=text.replace(/\D/g,'').slice(0,8);return digits.slice(0,2)+(digits.length>2?'.'+digits.slice(2,4):'')+(digits.length>4?'.'+digits.slice(4,8):'');
}
export const validDateValue=(value:string)=>!value||/^\d{4}-\d{2}-\d{2}$/.test(value)&&!!dateFromText(display(value));
export const validDateRange=(from:string,through:string)=>validDateValue(from)&&validDateValue(through)&&(!from||!through||from<=through);
type Props=Omit<InputHTMLAttributes<HTMLInputElement>,'type'|'value'|'onChange'|'onInput'|'defaultValue'>&{value?:string;onValueChange?:(value:string)=>void;showError?:boolean};
/** Four-digit year in the visible editor; the native calendar emits the same source-local ISO day. */
export function DateInput({value='',onValueChange,min,max,showError=true,...props}:Props){
 const errorId=useId();
 const [text,setText]=useState(()=>display(value)),last=useRef(value),input=useRef<HTMLInputElement>(null),calendar=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(value!==last.current){last.current=value;setText(display(value));input.current?.setCustomValidity('');}},[value]);
 function update(next:string){const formatted=dateText(next),parsed=dateFromText(formatted),invalid=!!formatted&&(!parsed||!!min&&parsed<min||!!max&&parsed>max);setText(formatted);input.current?.setCustomValidity(invalid?'Проверьте дату: дд.мм.гггг.':'');last.current=!formatted?'':parsed&&!invalid?parsed:formatted;onValueChange?.(last.current);}
 const invalid=!!text&&(!dateFromText(text)||!!min&&value<min||!!max&&value>max);
 return <span className={styles.field}><input {...props} ref={input} aria-invalid={invalid||props['aria-invalid']||undefined} aria-describedby={invalid&&showError?errorId:props['aria-describedby']} type="text" inputMode="numeric" placeholder="дд.мм.гггг" maxLength={10} value={text} onChange={e=>update(e.target.value)} onBlur={e=>{if(!text)input.current?.setCustomValidity('');props.onBlur?.(e);}}/><span className={styles.calendar}><CalendarDays size={15} aria-hidden="true"/><input ref={calendar} type="date" tabIndex={-1} aria-label={'Календарь: '+(props['aria-label']??'дата')} min={min??'0001-01-01'} max={max??'9999-12-31'} value={validDateValue(value)?value:''} disabled={props.disabled} onChange={e=>update(e.target.value)}/></span>{invalid&&showError&&<span id={errorId} role="alert" className={styles.error}>Проверьте дату: дд.мм.гггг.</span>}</span>;
}
