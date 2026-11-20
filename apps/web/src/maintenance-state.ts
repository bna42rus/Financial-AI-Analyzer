let active=false;
export const maintenanceActive=()=>active;
export function setMaintenanceActive(next:boolean){if(active===next)return;active=next;window.dispatchEvent(new CustomEvent('cashneuro-maintenance-active',{detail:next}));}
