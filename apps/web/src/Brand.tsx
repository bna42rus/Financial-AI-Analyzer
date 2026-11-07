import styles from './Brand.module.css';
/** Repository-owned vector identity; no remote image, font or analytics request. */
export function Brand({compact=false}:{compact?:boolean}){
 return <span className={styles.brand}><img className={styles.mark} src="/brand/cashneuro-favicon.svg" alt="" width="36" height="36"/>{!compact&&<span className={styles.name}>Cash<span>Neuro</span></span>}</span>;
}
