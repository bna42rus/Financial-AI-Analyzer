import styles from './Brand.module.css';
/** Repository-owned vector identity; no remote image, font or analytics request. */
export function Brand({compact=false,suffix}:{compact?:boolean;suffix?:string}){
 return <span className={styles.brand}><img className={styles.mark} src="/brand/cashneuro-favicon.svg" alt="" width="36" height="36"/>{!compact&&<span className={styles.wordmark}><span className={styles.name}>Cash<span>Neuro</span></span>{suffix&&<span className={styles.suffix}>{suffix}</span>}</span>}</span>;
}
