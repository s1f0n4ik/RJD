import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../app/Icons';
import { Modal, Switch, Seg } from '../../app/Modal';
import { Select } from '../../app/Select';
import {
    libraryApi,
    type BoardDiff,
    type BoardDiffItem,
    type Change,
    type Profile,
    type Workspace,
} from './library-api';
import { KIND_LABELS, paramLabel, passportDifferences, printable } from './profile-model';
import { versionNumber } from './ProfileBar';

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const message = (failure: unknown) => (failure instanceof Error ? failure.message : 'Ошибка запроса');

function Failure({ text }: { text: string }) {
    return (
        <div className="banner is-err" role="alert">
            <Icon name="warn" size={16} />
            <span>{text}</span>
        </div>
    );
}

function Buttons({ children }: { children: ReactNode }) {
    return <span className="spacer lb-buttons">{children}</span>;
}

const sizeOf = (bytes: number) =>
    bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;

export function ImportDialog({
    profiles,
    onClose,
    onImported,
}: {
    profiles: Profile[];
    onClose: () => void;
    onImported: (title: string, description: string) => void;
}) {
    const [tab, setTab] = useState<'file' | 'backup'>('file');
    const [files, setFiles] = useState<File[]>([]);
    const [name, setName] = useState('');
    const [id, setId] = useState('');
    const [activate, setActivate] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const input = useRef<HTMLInputElement>(null);
    const idValid = PROFILE_ID.test(id);
    const exists = profiles.some((profile) => profile.id === id);
    const ready = files.length > 0 && (tab === 'file' || (name.trim() && idValid));

    const submit = async () => {
        setBusy(true);
        setError('');
        try {
            if (tab === 'file') {
                const result = await libraryApi.loadFile(files[0], activate);
                onImported(
                    'Профиль импортирован',
                    `${result.profile.name}: версия v${result.version.number}${result.broken.length ? `, ошибок ссылок: ${result.broken.length}` : ''}`,
                );
            } else {
                const result = await libraryApi.importBackup(files, id, name.trim(), activate);
                onImported(
                    'Резервная копия импортирована',
                    `${name.trim()}: версия v${result.version.number}${result.broken.length ? `, ошибок ссылок: ${result.broken.length}` : ''}`,
                );
            }
        } catch (failure) {
            setError(message(failure));
            setBusy(false);
        }
    };

    return (
        <Modal
            title="Импорт профиля"
            onClose={busy ? () => undefined : onClose}
            footer={
                <Buttons>
                    <button className="btn" disabled={busy} onClick={onClose}>
                        Отмена
                    </button>
                    <button className="btn btn--acc" disabled={!ready || busy} onClick={() => void submit()}>
                        {busy ? 'Импорт…' : 'Импортировать'}
                    </button>
                </Buttons>
            }
        >
            <div className="modal-b">
                <Seg className="lb-modal-seg">
                    {(['file', 'backup'] as const).map((value) => (
                        <button
                            key={value}
                            className={tab === value ? 'is-on' : ''}
                            disabled={busy}
                            onClick={() => {
                                setTab(value);
                                setFiles([]);
                                setError('');
                            }}
                        >
                            {value === 'file' ? 'Файл профиля' : 'Резервная копия'}
                        </button>
                    ))}
                </Seg>
                {tab === 'backup' && (
                    <>
                        <div className="lb-fl">
                            <label htmlFor="lb-import-name">Название</label>
                            <input
                                id="lb-import-name"
                                className="inp inp--text inp--wide"
                                placeholder="Например, Искра-002"
                                autoComplete="off"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </div>
                        <div className="lb-fl">
                            <label htmlFor="lb-import-id">Идентификатор</label>
                            <input
                                id="lb-import-id"
                                className={`inp inp--text inp--wide num${id && !idValid ? ' is-err' : ''}`}
                                placeholder="iskra-002"
                                autoComplete="off"
                                value={id}
                                onChange={(event) => setId(event.target.value)}
                            />
                            {id && !idValid && (
                                <span className="hint is-err">Латиница в нижнем регистре, цифры, дефис и подчёркивание</span>
                            )}
                            {exists && <span className="hint">Профиль уже есть: будет добавлена новая версия</span>}
                        </div>
                    </>
                )}
                <input
                    ref={input}
                    type="file"
                    hidden
                    multiple={tab === 'backup'}
                    accept={tab === 'file' ? '.varan' : undefined}
                    onChange={(event) => {
                        setFiles(Array.from(event.target.files ?? []));
                        event.target.value = '';
                    }}
                />
                {files.length ? (
                    <div className="lb-file">
                        <Icon name="file" size={22} />
                        <span className="nm">
                            <b>{files.length === 1 ? files[0].name : `Архивов: ${files.length}`}</b>
                            <span>{sizeOf(files.reduce((sum, file) => sum + file.size, 0))}</span>
                        </span>
                        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setFiles([])}>
                            Другой файл
                        </button>
                    </div>
                ) : (
                    <div className="lb-drop">
                        <Icon name="down" size={28} />
                        <b>{tab === 'file' ? 'Выберите файл профиля .varan' : 'Выберите архив резервной копии'}</b>
                        <span>
                            {tab === 'file'
                                ? 'Файл создаёт кнопка «Экспорт» на другом мастере'
                                : 'Архив делает scripts/backup-config.sh на плате'}
                        </span>
                        <button className="btn" onClick={() => input.current?.click()}>
                            {tab === 'file' ? 'Выбрать файл' : 'Выбрать архив'}
                        </button>
                    </div>
                )}
                <div className="lb-sum">
                    <div>
                        <span>Загрузить профиль после импорта</span>
                        <Switch on={activate} disabled={busy} onToggle={setActivate}>
                            {null}
                        </Switch>
                    </div>
                </div>
                {activate && (
                    <div className="banner">
                        <Icon name="warn" size={16} />
                        <span>Камеры, запись, техзрение и 360 остановятся на время загрузки.</span>
                    </div>
                )}
                {error && <Failure text={error} />}
            </div>
        </Modal>
    );
}

export function ExportDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
    const [versionId, setVersionId] = useState(profile.version_id);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const version = profile.versions.find((item) => item.id === versionId) ?? profile.versions[0];
    const fileName = `${profile.id}-v${version?.number}.varan`;
    const download = async () => {
        setBusy(true);
        setError('');
        try {
            await libraryApi.exportProfile(profile.id, versionId, fileName);
            onClose();
        } catch (failure) {
            setError(message(failure));
            setBusy(false);
        }
    };
    return (
        <Modal
            title={`Экспорт профиля «${profile.name}»`}
            onClose={onClose}
            footer={
                <Buttons>
                    <button className="btn" onClick={onClose}>
                        Отмена
                    </button>
                    <button className="btn btn--acc" disabled={busy} onClick={() => void download()}>
                        <Icon name="up" size={16} />
                        {busy ? 'Подготовка…' : 'Скачать .varan'}
                    </button>
                </Buttons>
            }
        >
            <div className="modal-b">
                <div className="banner">
                    <Icon name="warn" size={16} />
                    <span>Пароли камер сохраняются в файле открытым текстом. Храните файл как секретный.</span>
                </div>
                <div className="lb-fl">
                    <span className="cap">Версия</span>
                    <Select
                        value={String(versionId)}
                        options={[...profile.versions]
                            .sort((a, b) => b.number - a.number)
                            .map((item) => ({
                                value: String(item.id),
                                label: `v${item.number}${item.id === profile.version_id ? ' · выбрана в профиле' : ''}`,
                                hint: item.label,
                            }))}
                        onChange={(value) => setVersionId(Number(value))}
                    />
                </div>
                <div className="lb-sum">
                    <div>
                        Файл<b>{fileName}</b>
                    </div>
                </div>
                <p>
                    В файл входит сохранённая версия профиля. Изменения паспорта и привязки к устройствам не входят: они
                    принадлежат машине.
                </p>
                {error && <Failure text={error} />}
            </div>
        </Modal>
    );
}

export function LoadDialog({
    current,
    target,
    disabled,
    onClose,
    onConfirm,
}: {
    current?: Profile;
    target: Profile;
    disabled: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <Modal
            title={`Загрузить профиль «${target.name}»?`}
            className="modal--confirm"
            onClose={onClose}
            footer={
                <Buttons>
                    <button className="btn" onClick={onClose}>
                        Отмена
                    </button>
                    <button className="btn btn--acc" disabled={disabled} onClick={onConfirm}>
                        Подтвердить загрузку
                    </button>
                </Buttons>
            }
        >
            <div className="modal-b">
                <div className="lb-load-comparison">
                    <div>
                        <span>Сейчас</span>
                        <b>{current?.name || 'Не выбран'}</b>
                    </div>
                    <Icon name="chev" size={20} />
                    <div>
                        <span>После загрузки</span>
                        <b>
                            {target.name} / v{versionNumber(target)}
                        </b>
                    </div>
                </div>
                <p>
                    Камеры, запись, техническое зрение, 360 и передача обнаружений остановятся на время загрузки. После
                    применения профиля модули запустятся снова.
                </p>
                <p className="muted">Загрузится сохранённый паспорт этого профиля.</p>
            </div>
        </Modal>
    );
}

export function DeleteDialog({
    profile,
    onClose,
    onConfirm,
}: {
    profile: Profile;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    return (
        <Modal
            title={`Удалить профиль «${profile.name}»?`}
            className="modal--confirm"
            onClose={onClose}
            footer={
                <Buttons>
                    <button className="btn" disabled={busy} onClick={onClose}>
                        Отмена
                    </button>
                    <button
                        className="btn btn--err"
                        disabled={busy}
                        onClick={() => {
                            setBusy(true);
                            onConfirm().catch((failure) => {
                                setError(message(failure));
                                setBusy(false);
                            });
                        }}
                    >
                        Удалить профиль
                    </button>
                </Buttons>
            }
        >
            <div className="modal-b">
                <p>
                    Будут удалены все версии профиля ({profile.versions.length}) и привязки к устройствам. Файлы моделей
                    останутся, пока их использует другой профиль.
                </p>
                <p className="muted">Перед удалением можно сохранить файл кнопкой «Экспорт».</p>
                {error && <Failure text={error} />}
            </div>
        </Modal>
    );
}

export function VersionsDialog({
    profile,
    lock,
    onClose,
    onSelect,
    onRemove,
}: {
    profile: Profile;
    lock: string;
    onClose: () => void;
    onSelect: (versionId: number) => Promise<void>;
    onRemove: (versionId: number) => Promise<void>;
}) {
    const [busy, setBusy] = useState(0);
    const [error, setError] = useState('');
    const run = (versionId: number, action: (id: number) => Promise<void>) => {
        setBusy(versionId);
        setError('');
        action(versionId)
            .catch((failure) => setError(message(failure)))
            .finally(() => setBusy(0));
    };
    return (
        <Modal
            title="Версии профиля"
            onClose={onClose}
            footer={
                <Buttons>
                    <button className="btn" onClick={onClose}>
                        Закрыть
                    </button>
                </Buttons>
            }
        >
            <div className="modal-b">
                {profile.active && (
                    <div className="banner">
                        <Icon name="warn" size={16} />
                        <span>Профиль загружен: смена версии остановит модули и загрузит конфигурацию заново.</span>
                    </div>
                )}
                <div className="lb-vlist">
                    {[...profile.versions]
                        .sort((a, b) => b.number - a.number)
                        .map((version) => {
                            const current = version.id === profile.version_id;
                            return (
                                <div className="lb-vl" key={version.id}>
                                    <span className="n num">v{version.number}</span>
                                    <span className="d">
                                        <b>{version.label || 'резервная копия'}</b>
                                        <span>
                                            {new Date(version.created * 1000).toLocaleString('ru-RU', {
                                                day: 'numeric',
                                                month: 'short',
                                                hour: '2-digit',
                                                minute: '2-digit',
                                            })}
                                        </span>
                                    </span>
                                    {current ? (
                                        <span className="tag is-acc">Выбрана</span>
                                    ) : (
                                        <>
                                            <button
                                                className="btn btn--sm"
                                                disabled={!!lock || !!busy}
                                                data-tip={lock || undefined}
                                                onClick={() => run(version.id, onSelect)}
                                            >
                                                Выбрать
                                            </button>
                                            <button
                                                className="icon-btn"
                                                aria-label={`Удалить версию v${version.number}`}
                                                disabled={!!lock || !!busy}
                                                onClick={() => run(version.id, onRemove)}
                                            >
                                                <Icon name="trash" size={14} />
                                            </button>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                </div>
                {error && <Failure text={error} />}
            </div>
        </Modal>
    );
}

type Phase =
    | { kind: 'checking' }
    | { kind: 'error'; text: string }
    | { kind: 'none' }
    | { kind: 'result'; diff: BoardDiff };

const itemKey = (item: BoardDiffItem) => `${item.device_id}/${item.kind}/${item.key}`;

export function UpdatePassportDialog({
    profile,
    onClose,
    onApplied,
}: {
    profile: Profile;
    onClose: () => void;
    onApplied: (snapshot: Workspace, count: number, applicationError: string | null) => void;
}) {
    const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
    const [attempt, setAttempt] = useState(0);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let stale = false;
        setPhase({ kind: 'checking' });
        libraryApi
            .boardDiff(profile.id)
            .then((diff) => {
                if (stale) return;
                const failed = diff.devices.filter((device) => device.state === 'error');
                if (diff.devices.length && failed.length === diff.devices.length)
                    setPhase({ kind: 'error', text: `Устройство ${failed[0].device_id} не ответило: ${failed[0].error}. Паспорт не изменён.` });
                else if (!diff.items.length) setPhase({ kind: 'none' });
                else {
                    setChecked(new Set(diff.items.map(itemKey)));
                    setPhase({ kind: 'result', diff });
                }
            })
            .catch((failure) => !stale && setPhase({ kind: 'error', text: `${message(failure)}. Паспорт не изменён.` }));
        return () => {
            stale = true;
        };
    }, [profile.id, attempt]);

    const apply = async () => {
        if (phase.kind !== 'result') return;
        const diff = phase.diff;
        const changes: Change[] = [];
        const seen = new Set<string>();
        for (const item of diff.items) {
            const ref = `${item.kind}/${item.key}`;
            if (!checked.has(itemKey(item)) || seen.has(ref)) continue;
            seen.add(ref);
            changes.push({ kind: item.kind, key: item.key, body: item.body });
        }
        setBusy(true);
        setError('');
        try {
            const result = await libraryApi.savePassport(profile.id, diff, changes);
            onApplied(result.snapshot, changes.length, result.application_error);
        } catch (failure) {
            setError(message(failure));
            setBusy(false);
        }
    };

    const title = 'Обновить паспорт';
    const closer = (
        <button className="btn" disabled={busy} onClick={onClose}>
            {phase.kind === 'none' ? 'Закрыть' : 'Отмена'}
        </button>
    );
    let body: ReactNode;
    let footer: ReactNode;
    if (phase.kind === 'checking') {
        body = (
            <div className="lb-wait" role="status">
                <span className="spin" />
                <span>
                    <b>Сравниваю машину с профилем</b>
                    <br />
                    Читаю настройки с устройств
                </span>
            </div>
        );
        footer = <Buttons>{closer}</Buttons>;
    } else if (phase.kind === 'none') {
        body = (
            <div className="lb-wait">
                <i className="dot ok" />
                <span>
                    <b>Отличий нет</b>
                    <br />
                    Настройки машины совпадают с профилем «{profile.name}» v{versionNumber(profile)} и паспортом.
                </span>
            </div>
        );
        footer = (
            <Buttons>
                <button className="btn btn--acc" onClick={onClose}>
                    Закрыть
                </button>
            </Buttons>
        );
    } else if (phase.kind === 'error') {
        body = <Failure text={phase.text} />;
        footer = (
            <Buttons>
                <button className="btn" onClick={onClose}>
                    Закрыть
                </button>
                <button className="btn btn--acc" onClick={() => setAttempt((value) => value + 1)}>
                    Повторить
                </button>
            </Buttons>
        );
    } else {
        const { diff } = phase;
        const all = diff.items.length;
        const failed = diff.devices.filter((device) => device.state === 'error');
        body = (
            <>
                <div className="lb-pu-h">
                    <span>
                        Найдено отличий: <b>{all}</b>
                    </span>
                    <button
                        className="btn btn--sm btn--ghost"
                        onClick={() => setChecked(checked.size === all ? new Set() : new Set(diff.items.map(itemKey)))}
                    >
                        {checked.size === all ? 'Снять все' : 'Выбрать все'}
                    </button>
                </div>
                <div className="lb-pu">
                    {diff.items.map((item) => {
                        const on = checked.has(itemKey(item));
                        const first = item.changes[0];
                        return (
                            <button
                                key={itemKey(item)}
                                className={`lb-pu-r${on ? ' is-on' : ''}`}
                                role="checkbox"
                                aria-checked={on}
                                onClick={() =>
                                    setChecked((previous) => {
                                        const next = new Set(previous);
                                        next.has(itemKey(item)) ? next.delete(itemKey(item)) : next.add(itemKey(item));
                                        return next;
                                    })
                                }
                            >
                                <span className={`lb-cb${on ? ' is-on' : ''}`}>{on && <Icon name="check" size={13} />}</span>
                                <span className="lb-name">
                                    <b>{item.name}</b>
                                    <span>{KIND_LABELS[item.kind] ?? item.kind}</span>
                                </span>
                                <span className="par">
                                    {item.state === 'add' ? 'Новая сущность' : paramLabel(first.path)}
                                    {item.changes.length > 1 && <small> и ещё {item.changes.length - 1}</small>}
                                </span>
                                <span className="chg">
                                    {item.state === 'add' ? (
                                        <span className="b">нет в профиле</span>
                                    ) : (
                                        <>
                                            <span className="a">{printable(first.was, first.path)}</span>
                                            <Icon name="arr" size={14} />
                                            <span className="b">{printable(first.now, first.path)}</span>
                                        </>
                                    )}
                                </span>
                            </button>
                        );
                    })}
                </div>
                {!!failed.length && <Failure text={`Не ответили устройства: ${failed.map((device) => device.device_id).join(', ')}`} />}
                {!!diff.skipped.length && (
                    <p className="muted">Сущностей профиля нет на плате: {diff.skipped.length}. В паспорт они не записываются.</p>
                )}
                <p className="lb-pu-n">
                    <Icon name="lock" size={13} />
                    Профиль «{profile.name}» v{versionNumber(profile)} не меняется. Отмеченные значения запишутся только в паспорт этой машины.
                </p>
                {error && <Failure text={error} />}
            </>
        );
        footer = (
            <Buttons>
                {closer}
                <button className="btn btn--acc" disabled={!checked.size || busy} onClick={() => void apply()}>
                    {busy ? 'Запись…' : `Записать в паспорт${checked.size ? ` · ${checked.size}` : ''}`}
                </button>
            </Buttons>
        );
    }
    return (
        <Modal title={title} size={phase.kind === 'result' ? 'mid' : 'default'} onClose={busy ? () => undefined : onClose} footer={footer}>
            <div className="modal-b">{body}</div>
        </Modal>
    );
}

export function FoldPassportDialog({
    workspace,
    profile,
    onClose,
    onConfirm,
}: {
    workspace: Workspace;
    profile: Profile;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const list = passportDifferences(workspace);
    const next = Math.max(0, ...profile.versions.map((version) => version.number)) + 1;
    return (
        <Modal
            title="Заменить паспорт по умолчанию?"
            className="modal--confirm"
            onClose={busy ? () => undefined : onClose}
            footer={
                <Buttons>
                    <button className="btn" disabled={busy} onClick={onClose}>
                        Отмена
                    </button>
                    <button
                        className="btn btn--acc"
                        disabled={busy || !list.length}
                        onClick={() => {
                            setBusy(true);
                            onConfirm().catch((failure) => {
                                setError(message(failure));
                                setBusy(false);
                            });
                        }}
                    >
                        {busy ? 'Замена…' : `Заменить · ${list.length}`}
                    </button>
                </Buttons>
            }
        >
            <div className="modal-b">
                <p>
                    Значения профиля «{workspace.profile.name}» v{workspace.version.number} будут заменены текущим состоянием машины:
                    отличий <b>{list.length}</b> станут новой версией <b>v{next}</b>, паспорт после этого совпадёт с профилем.
                </p>
                <div className="lb-vlist lb-reset-list">
                    {list.map((item) => (
                        <div className="lb-vl" key={`${item.kind}/${item.key}`}>
                            <span className="d">
                                <b>{item.name}</b>
                                <span>{KIND_LABELS[item.kind] ?? item.kind}</span>
                            </span>
                        </div>
                    ))}
                </div>
                <p className="muted">
                    Версия v{workspace.version.number} сохранится в «Версиях профиля», к ней можно вернуться. Привязки устройств и
                    карточка машины в профиль не попадают. Работающая конфигурация на устройствах не меняется.
                </p>
                {error && <Failure text={error} />}
            </div>
        </Modal>
    );
}

export function ResetPassportDialog({
    workspace,
    onClose,
    onConfirm,
}: {
    workspace: Workspace;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const list = passportDifferences(workspace);
    return (
        <Modal
            title="Сбросить весь паспорт к профилю?"
            className="modal--confirm"
            onClose={busy ? () => undefined : onClose}
            footer={
                <Buttons>
                    <button className="btn" disabled={busy} onClick={onClose}>
                        Отмена
                    </button>
                    <button
                        className="btn btn--err"
                        disabled={busy || !list.length}
                        onClick={() => {
                            setBusy(true);
                            onConfirm().catch((failure) => {
                                setError(message(failure));
                                setBusy(false);
                            });
                        }}
                    >
                        {busy ? 'Сброс…' : `Сбросить · ${list.length}`}
                    </button>
                </Buttons>
            }
        >
            <div className="modal-b">
                <p>
                    Отличий от профиля: <b>{list.length}</b>. Все они вернутся к значениям профиля «{workspace.profile.name}» v
                    {workspace.version.number}. Привязки устройств и карточка машины не меняются.
                </p>
                <div className="lb-vlist lb-reset-list">
                    {list.map((item) => (
                        <div className="lb-vl" key={`${item.kind}/${item.key}`}>
                            <span className="d">
                                <b>{item.name}</b>
                                <span>{KIND_LABELS[item.kind] ?? item.kind}</span>
                            </span>
                        </div>
                    ))}
                </div>
                <p className="muted">Если профиль загружен, значения сразу применятся на устройствах.</p>
                {error && <Failure text={error} />}
            </div>
        </Modal>
    );
}
