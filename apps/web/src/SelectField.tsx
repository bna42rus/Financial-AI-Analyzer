import {Children,Fragment,isValidElement,useEffect,useRef,useState} from 'react';
import type {ChangeEvent,ReactNode,SelectHTMLAttributes} from 'react';
import {ChoicePicker,choiceStyles,foldChoice} from './ChoicePicker';

type Option={value:string;label:string;disabled:boolean};

function optionsFrom(children:ReactNode,disabled=false):Option[]{
 return Children.toArray(children).flatMap(child=>{
  if(!isValidElement<{children?:ReactNode;value?:string|number;label?:string;disabled?:boolean;hidden?:boolean}>(child))return [];
  const props=child.props;
  if(child.type===Fragment||child.type==='optgroup')return optionsFrom(props.children,disabled||props.disabled);
  if(child.type!=='option'||props.hidden)return [];
  const text=Children.toArray(props.children).filter(part=>typeof part==='string'||typeof part==='number').join('').trim();
  return [{value:String(props.value??text),label:props.label??text,disabled:disabled||!!props.disabled}];
 });
}

function valuesOf(value:SelectHTMLAttributes<HTMLSelectElement>['value']):string[]{
 return Array.isArray(value)?Array.from(value,String):value===undefined?[]:[String(value)];
}

export function SelectField({children,value,defaultValue,onChange,disabled,required,multiple,className,style,id,autoFocus,tabIndex,
 'aria-label':ariaLabel,'aria-invalid':invalid,'aria-describedby':description,'aria-labelledby':labelledBy,...native}:SelectHTMLAttributes<HTMLSelectElement>){
 const select=useRef<HTMLSelectElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const [draft,setDraft]=useState(()=>valuesOf(defaultValue));
 const [missing,setMissing]=useState(false);
 const [formLabel,setFormLabel]=useState('');
 const options=optionsFrom(children);
 const selectedValues=value===undefined?draft:valuesOf(value);
 const selected=options.filter(option=>selectedValues.includes(option.value));
 const current=multiple?selected:selected.length?selected:options.filter(option=>!option.disabled).slice(0,1);
 const label=current.length>1?'Выбрано: '+current.length:current[0]?.label||'Выберите значение';

 useEffect(()=>{
  const node=select.current,form=node?.form;
  if(!node||!form)return;
  const reset=()=>queueMicrotask(()=>{
   if(!node.isConnected)return;
   if(value===undefined)setDraft(Array.from(node.selectedOptions,option=>option.value));
   setMissing(false);
  });
  form.addEventListener('reset',reset);
  return()=>form.removeEventListener('reset',reset);
 },[value]);

 useEffect(()=>{
  const button=trigger.current;
  const label=button?.labels?.[0];
  if(!label||ariaLabel||labelledBy)return;
  const content=Array.from(label.childNodes).filter(child=>child!==button&&child!==select.current).map(child=>child.textContent??'').join(' ').trim();
  setFormLabel(content);
 },[ariaLabel,labelledBy]);

 function change(event:ChangeEvent<HTMLSelectElement>){
  if(value===undefined)setDraft(Array.from(event.currentTarget.selectedOptions,option=>option.value));
  setMissing(false);
  onChange?.(event);
 }

 function choose(option:Option){
  const node=select.current;
  if(!node||node.matches(':disabled'))return;
  if(multiple){
   const nativeOption=Array.from(node.options).find(item=>item.value===option.value);
   if(nativeOption)nativeOption.selected=!nativeOption.selected;
  }else node.value=option.value;
  node.dispatchEvent(new Event('change',{bubbles:true}));
 }

 return <>
  <ChoicePicker id={id} triggerRef={trigger} className={className} style={style} label={label} title={ariaLabel??(formLabel||'Выбор значения')} role="combobox" value={multiple?undefined:current[0]?.value}
   disabled={disabled} aria-label={ariaLabel??(formLabel||undefined)} aria-labelledby={labelledBy} aria-describedby={description} aria-invalid={invalid||missing||undefined} aria-required={required} autoFocus={autoFocus} tabIndex={tabIndex}>
   {(query,close)=>{
    const matches=options.filter(option=>foldChoice(option.label).includes(query));
    return matches.length?matches.map((option,index)=>{
     const checked=current.some(item=>item.value===option.value);
     return <label key={option.value+':'+index} className={choiceStyles.choice}>
      <input type={multiple?'checkbox':'radio'} data-choice-option={option.value} checked={checked} disabled={option.disabled}
       onClick={()=>{if(checked&&!multiple)close();}} onChange={()=>{choose(option);if(!multiple)close();}}/>
      <span>{option.label}</span>
     </label>;
    }):<p className={choiceStyles.empty}>Варианты не найдены</p>;
   }}
  </ChoicePicker>
  {/* This backing control preserves native form values, resets and validation. */}
  <select {...native} ref={select} className={choiceStyles.native} hidden aria-hidden="true" tabIndex={-1}
   value={value} defaultValue={defaultValue} disabled={disabled} required={required} multiple={multiple} onChange={change}
   onInvalid={event=>{native.onInvalid?.(event);event.preventDefault();setMissing(true);trigger.current?.focus();}}>{children}</select>
 </>;
}
