import type {SelectHTMLAttributes,SyntheticEvent} from 'react';
/** Commit native picker input immediately; some mobile pickers defer change until closing. */
export function WidgetSelect(props:SelectHTMLAttributes<HTMLSelectElement>){
 const commit=(event:SyntheticEvent<HTMLSelectElement>)=>{if(event.currentTarget.value!==String(props.value??''))props.onChange?.({...event,target:event.currentTarget});};
 return <select {...props} onInput={commit} onChange={commit}/>;
}
