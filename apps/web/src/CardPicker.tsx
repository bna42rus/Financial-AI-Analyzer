import {SelectField} from './SelectField';
export type PaymentCard={id:string;last4:string|null;brand?:string|null;forRenewal?:boolean};
export const cardLabel=(c:PaymentCard)=>(c.brand||'Карта')+' •••• '+(c.last4??'—');
export function CardPicker({cards=[],value,onChange,disabled=false,newCard=true,label='Карта для оплаты'}:{cards?:PaymentCard[];value:string;onChange:(id:string)=>void;disabled?:boolean;newCard?:boolean;label?:string}){
 if(!cards.length&&newCard)return null;
 return <label>{label}<SelectField aria-label={label} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>{newCard?<option value="">Новая карта</option>:!value&&<option value="">Выберите карту</option>}{cards.map(c=><option key={c.id} value={c.id}>{cardLabel(c)}{c.forRenewal?' · автопродление':''}</option>)}</SelectField></label>;
}
