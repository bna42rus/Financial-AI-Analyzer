import { useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, CircleAlert, X } from 'lucide-react';
import { formatDate, formatMoney } from './demo/overview';
import type { DemoOperation } from './demo/overview';
import { roleLabels, statusLabel } from './demo/operations';
import common from './App.module.css';
import styles from './Operations.module.css';

export function OperationCard({row,onClose}:{row:DemoOperation|null;onClose:()=>void}) {
  const opener=useRef<HTMLElement|null>(null);
  return <Dialog.Root open={row!==null} onOpenChange={open=>!open&&onClose()}><Dialog.Portal>
    <Dialog.Overlay className={common.overlay} />
    <Dialog.Content className={styles.drawer} aria-describedby="operation-description" onOpenAutoFocus={()=>{opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;}} onCloseAutoFocus={event=>{if(opener.current?.isConnected){event.preventDefault();opener.current.focus({preventScroll:true});}}}>
      <div className={styles.drawerHead}><Dialog.Close className={`${common.button} ${styles.back}`}><ArrowLeft size={16} aria-hidden="true" />Назад к списку</Dialog.Close><span>Карточка операции</span><Dialog.Close className={common.iconButton} aria-label="Закрыть карточку"><X size={20} aria-hidden="true" /></Dialog.Close></div>
      <Dialog.Title className={styles.cardTitle}>{row?.merchant}</Dialog.Title>
      <Dialog.Description id="operation-description">Вымышленная операция из демонстрационного примера.</Dialog.Description>
      {row&&<><strong className={`${styles.cardAmount} ${BigInt(row.amountMinor)>0n?styles.positive:''}`}>{formatMoney(row.amountMinor)}</strong><p className={styles.cardDate}>{formatDate(row.date)} {row.date.slice(0,4)} · {row.account}</p>
        <span className={`${styles.badge} ${row.requiresAttention?styles.warning:''}`}>{statusLabel(row)}</span>
        {row.requiresAttention&&<div className={styles.reviewNote}><CircleAlert size={18} aria-hidden="true" /><span>{row.role==='unresolved'?'Не определено, для чего сделан перевод. Пока он не учитывается в расходах и доходах.':'Категорию расхода нужно проверить. Сумма уже учтена как расход.'}</span></div>}
        <dl className={styles.fields}><div><dt>Тип операции</dt><dd>{row.kind}</dd></div><div><dt>Финансовый смысл</dt><dd>{roleLabels[row.role]}</dd></div><div><dt>Категория</dt><dd>{row.category||'Не задана'}</dd></div><div><dt>Банк</dt><dd>{row.bank}</dd></div><div><dt>Счёт</dt><dd>{row.account}</dd></div><div><dt>Участие в аналитике</dt><dd>{row.excluded?'Исключена':row.role==='neutral'?'Нейтральное движение':row.role==='unresolved'?'Ожидает разбора':'Учитывается'}</dd></div></dl>
        <section className={styles.cardSection}><h3>Как определено</h3><p>Тип, смысл и категория заранее заданы в демонстрационном примере.</p></section>
        <details className={styles.source}><summary>Данные примера</summary><p>Банковская выписка не загружалась. Исходные значения этого примера:</p><dl className={styles.fields}><div><dt>Дата</dt><dd>{row.date}</dd></div><div><dt>Сумма</dt><dd>{formatMoney(row.amountMinor)}</dd></div><div><dt>Описание</dt><dd>{row.merchant}</dd></div><div><dt>Банк и счёт</dt><dd>{row.bank} · {row.account}</dd></div></dl></details>
        <p className={styles.readOnly}>Сейчас пример доступен для просмотра. Исправления, связи и сохранение добавим позже.</p>
      </>}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
