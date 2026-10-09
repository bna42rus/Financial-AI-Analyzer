import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CircleAlert, FileText, HelpCircle, ShieldCheck, Upload, UserRound, X } from 'lucide-react';
import type { Appearance } from './Settings';
import common from './App.module.css';
import styles from './ShellDialogs.module.css';

function Modal({ open, onClose, title, description, children, focusSelector }: { open: boolean; onClose: () => void; title: string; description: string; children: ReactNode; focusSelector?: string }) {
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const sourceHash = useRef('');
  return <Dialog.Root open={open} onOpenChange={next => !next && onClose()}><Dialog.Portal>
    <Dialog.Overlay className={common.overlay} />
    <Dialog.Content ref={content} className={`${common.dialog} ${styles.modal}`} onOpenAutoFocus={event => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; sourceHash.current = window.location.hash; if (focusSelector) { event.preventDefault(); content.current?.querySelector<HTMLElement>(focusSelector)?.focus(); } }} onCloseAutoFocus={event => { if (sourceHash.current !== window.location.hash) { event.preventDefault(); return; } if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus({ preventScroll: true }); } }}>
      <div className={common.dialogHead}><Dialog.Title>{title}</Dialog.Title><Dialog.Close className={common.iconButton} aria-label={`Закрыть: ${title}`}><X size={20} aria-hidden="true" /></Dialog.Close></div>
      <Dialog.Description>{description}</Dialog.Description>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

type SelectedFile = { id: number; name: string; size: number; format: string | null; error: string | null };
function sizeLabel(bytes: number) { return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes < 1_000_000 ? bytes / 1000 : bytes / 1_000_000) + (bytes < 1_000_000 ? ' КБ' : ' МБ'); }

export function UploadDialog({ open, onClose, onOpenImports }: { open: boolean; onClose: () => void; onOpenImports: () => void }) {
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  useEffect(() => { if (!open) { setFiles([]); setDragging(false); } }, [open]);
  function choose(selected: FileList | null) {
    if (!selected) return;
    const additions = Array.from(selected, file => {
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      const format = extension && ['pdf', 'csv', 'xlsx'].includes(extension) ? extension.toUpperCase() : null;
      return { id: ++nextId.current, name: file.name, size: file.size, format, error: !format ? 'Выберите PDF, CSV или XLSX.' : file.size === 0 ? 'Файл пустой. Выберите другую копию выписки.' : null };
    });
    setFiles(current => [...current, ...additions]);
    if (input.current) input.current.value = '';
  }
  return <Modal open={open} onClose={onClose} title="Загрузка выписок" description="Выберите один или несколько файлов банковских выписок." focusSelector="[data-file-choose]">
    <div className={styles.notice}><ShieldCheck size={20} aria-hidden="true" /><p>Сейчас доступен только выбор файлов. Их содержимое не читается, никуда не отправляется и не создаёт операций. Обработку выписок подключим на этапе импорта.</p></div>
    <div className={`${styles.dropzone} ${dragging ? styles.dragging : ''}`} aria-label="Выбор выписок" onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); }}>
      <Upload size={28} aria-hidden="true" /><h3>Перетащите файлы сюда</h3><p>или выберите их на устройстве</p>
      <input ref={input} type="file" multiple accept=".pdf,.csv,.xlsx" aria-label="Файлы выписок" className={styles.fileInput} onChange={event => choose(event.target.files)} />
      <button className={common.primaryButton} data-file-choose onClick={() => input.current?.click()}>Выбрать файлы</button>
      <small>PDF, CSV, XLSX · поддержка чтения форматов появится позже</small>
    </div>
    {files.length > 0 && <><p className={styles.selectionSummary} role="status">Выбрано файлов: {files.length}. Обработка не запускалась.</p><ul className={styles.files} aria-label="Выбранные файлы">{files.map(file => <li key={file.id}>
      {file.error ? <CircleAlert size={19} aria-hidden="true" /> : <FileText size={19} aria-hidden="true" />}
      <div><strong>{file.name}</strong><small>{file.format ?? 'Другой тип файла'} · {sizeLabel(file.size)}</small><p className={file.error ? styles.error : styles.secondary}>{file.error ?? 'Обработка пока не подключена'}</p></div>
      <button className={common.iconButton} aria-label={`Убрать файл: ${file.name}`} onClick={() => setFiles(current => current.filter(item => item.id !== file.id))}><X size={17} aria-hidden="true" /></button>
    </li>)}</ul><button className={common.button} onClick={() => setFiles([])}>Очистить выбор</button></>}
    <details className={styles.explanation}><summary>Как будет работать импорт</summary><p>После подключения обработка начнётся автоматически на устройстве: чтение выписки, очистка реквизитов и проверка данных. На сервер будут передаваться только разрешённые очищенные сведения. Пароль защищённого PDF останется на устройстве.</p><p>Результат покажет новые операции, повторы, обновления и записи, требующие проверки. Ошибки чтения будут показаны отдельно.</p></details>
    <div className={styles.actions}><button className={common.button} onClick={onOpenImports}>История загрузок</button><Dialog.Close className={common.button}>Закрыть</Dialog.Close></div>
    <p className={styles.footnote}>При закрытии окна выбранные файлы убираются из списка. Выписка на устройстве сохраняется.</p>
  </Modal>;
}

const profileSections = [
  { id: 'account', label: 'Аккаунт', icon: UserRound },
  { id: 'security', label: 'Безопасность', icon: ShieldCheck },
  { id: 'access', label: 'Доступ', icon: FileText },
  { id: 'support', label: 'Поддержка', icon: HelpCircle },
] as const;
type ProfileSection = typeof profileSections[number]['id'];

export function ProfileDialog({ open, onClose, appearance, onAppearanceChange, demo, onCloseDemo, onOpenPrivacy }: { open: boolean; onClose: () => void; appearance: Appearance; onAppearanceChange: (value: Appearance) => void; demo: boolean; onCloseDemo: () => void; onOpenPrivacy: () => void }) {
  const [section, setSection] = useState<ProfileSection>('account');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => { if (!open) { setSection('account'); setSubject(''); setMessage(''); } }, [open]);
  function info(label: string, value: string) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
  return <Modal open={open} onClose={onClose} title="Профиль" description="Аккаунт, безопасность, доступ и помощь.">
    <p className={styles.notice}>Это первая версия интерфейса. Пользовательский аккаунт и авторизация ещё не подключены.</p>
    <nav className={styles.profileMenu} aria-label="Разделы профиля">{profileSections.map(item => <button key={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><item.icon size={18} aria-hidden="true" />{item.label}</button>)}</nav>
    <section className={styles.profileContent} aria-label={profileSections.find(item => item.id === section)!.label}>
      {section === 'account' && <><h3>Аккаунт</h3><dl className={styles.info}>{info('Email', 'Аккаунт ещё не создан')}{info('Язык интерфейса', 'Русский')}{info('Часовой пояс браузера', timezone)}</dl><p className={styles.secondary}>Смена email с подтверждением нового адреса и настройка часового пояса появятся после подключения аккаунтов. Банковские даты не сдвигаются при смене часового пояса.</p></>}
      {section === 'security' && <><h3>Безопасность</h3><dl className={styles.info}>{info('Вход', 'Email и пароль — после подключения')}{info('Сессии', 'Список пока недоступен')}{info('История безопасности', 'Входы и изменения аккаунта — после подключения')}</dl><p className={styles.secondary}>Здесь можно будет сменить пароль и завершить другие сессии. Пароли и коды входа в этой версии не запрашиваются.</p></>}
      {section === 'access' && <><h3>Доступ</h3><dl className={styles.info}>{info('Статус', 'Оплаченный доступ не проверяется')}{info('Окончание доступа', 'Дата пока не определена')}{info('Использование AI', 'AI не подключён')}</dl><p className={styles.secondary}>Оплату подтверждает администратор. Нажатие «Я оплатил» само по себе не открывает и не продлевает доступ. Тарифы и продление появятся на этапе подключения доступа.</p></>}
      {section === 'support' && <><h3>Поддержка</h3><p className={styles.secondary}>Можно подготовить черновик обращения. Отправка, адрес поддержки и вложения ещё не подключены.</p><label className={styles.field}>Тема обращения<input value={subject} onChange={event => setSubject(event.target.value)} /></label><label className={styles.field}>Сообщение<textarea rows={4} value={message} onChange={event => setMessage(event.target.value)} /></label><p className={styles.footnote}>Черновик остаётся в памяти до закрытия окна. Операции, диалоги, выписки и диагностика автоматически не прикладываются.</p><button className={common.button} disabled={!subject && !message} onClick={() => { setSubject(''); setMessage(''); }}>Очистить черновик</button></>}
    </section>
    <label className={styles.field}>Тема оформления<select value={appearance.theme} onChange={event => onAppearanceChange({ ...appearance, theme: event.target.value as Appearance['theme'] })}><option value="system">Как на устройстве</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
    <div className={styles.actions}><button className={common.button} onClick={onOpenPrivacy}>Конфиденциальность</button>{demo && <button className={common.button} onClick={onCloseDemo}>Закрыть пример</button>}<Dialog.Close className={common.button}>Закрыть</Dialog.Close></div>
    <p className={styles.footnote}>Оформление сохраняется на этом устройстве. Вход и выход из аккаунта появятся после подключения авторизации.</p>
  </Modal>;
}
