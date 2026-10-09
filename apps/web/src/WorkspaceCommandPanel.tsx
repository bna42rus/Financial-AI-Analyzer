import type {CommandState,WorkspaceCommand} from './workspace-command';
import {formatMoney} from './demo/overview';
import common from './App.module.css';
import styles from './Workspace.module.css';
export function WorkspaceCommandPanel({state,command}:{state:CommandState;command:WorkspaceCommand|null}){
 return <section aria-label="Состояние изменения">
 {state.error&&<p role="alert" className={common.error}>{state.error}</p>}{state.message&&<p role="status">{state.message}</p>}{state.phase==='sending'&&<p role="status">Проверяем и сохраняем изменение…</p>}
 {state.phase==='retry'&&<button className={common.primaryButton} onClick={()=>void command?.retry()}>Повторить то же изменение</button>}{state.phase==='stale'&&<button className={common.button} onClick={()=>void command?.reload()}>Обновить данные перед правкой</button>}
 {state.preview&&<div className={styles.preview} aria-label="Последствия изменения"><h2>{state.title}</h2><p>Затронуто операций: {state.preview.impact.affectedOperationIds.length}. Расчёт за всю историю; общие фильтры не ограничивают изменение.</p><dl>{[['Расходы',state.preview.impact.before.netExpensesMinor,state.preview.impact.after.netExpensesMinor],['Доходы',state.preview.impact.before.incomeMinor,state.preview.impact.after.incomeMinor],['Не определено',state.preview.impact.before.unresolvedMinor,state.preview.impact.after.unresolvedMinor]].map(([n,b,a])=><div key={n}><dt>{n}</dt><dd>{formatMoney(b!)} → {formatMoney(a!)}</dd></div>)}</dl>{state.preview.impact.dependencyConflicts.length>0&&<p>Связей для проверки: {state.preview.impact.dependencyConflicts.length}. Невозможные связи не участвуют в итогах.</p>}<div className={styles.actions}><button className={common.primaryButton} disabled={state.phase!=='preview'} onClick={()=>void command?.confirm()}>Применить изменение</button><button className={common.button} disabled={state.phase!=='preview'} onClick={()=>command?.cancel()}>Не применять</button></div></div>}
 {state.undoActionId&&<button className={common.button} disabled={state.phase!=='idle'} onClick={()=>void command?.undo()}>Отменить последнее изменение</button>}
 </section>;
}
