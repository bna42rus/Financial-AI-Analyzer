import styles from './Brand.module.css';
/** Repository-owned vector identity; no remote image, font or analytics request. */
export function Brand({compact=false}:{compact?:boolean}){
 return <span className={styles.brand}><svg className={styles.mark} viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="18" fill="currentColor"/><path d="M43 18a20 20 0 1 0 0 28" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round"/><path d="m24 37 8-10 7 5 9-13" fill="none" stroke="#c6c3ff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="24" cy="37" r="3" fill="#fff"/><circle cx="48" cy="19" r="3" fill="#fff"/></svg>{!compact&&<span className={styles.name}>Cash<span>Neuro</span></span>}</span>;
}
