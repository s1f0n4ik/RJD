import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../app/Icons';
import { Modal, isModalOpen } from '../../app/Modal';
import { useToast } from '../../app/Toast';
import { formatBytes } from '../devices/model';
import {
    updateApi, useUpdateState,
    type StepId, type StepState, type UpBoard, type UpCheck, type UpEvent, type UpRollout, type UpRow, type UpState,
} from './update-api';
import './update.css';

const SLOW_MS = 5000;
const FAST_MS = 1500;
const LOG_MS = 3000;

const STEPS: Array<[StepId, string]> = [['delivery', 'Доставка'], ['install', 'Установка'], ['master', 'Часть мастера'], ['check', 'Проверка']];
const WORD: Record<StepState, [string, string]> = {
    ok: ['is-ok', 'готово'], run: ['is-run', 'идёт'], fail: ['is-fail', 'сбой'], back: ['is-back', 'возвращена'], wait: ['', 'ждёт'], na: ['is-na', ''],
};
const CHECK_ICON: Record<UpCheck['level'], IconName> = { ok: 'okc', err: 'xc', warn: 'warn', skip: 'minus' };
const OLDER = 'Файл не новее установленной версии';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const elapsed = (seconds: number) => {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const elapsedWords = (seconds: number) => {
    const s = Math.max(0, Math.round(seconds));
    return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с`;
};
const names = (list: Array<{ name: string }>) => list.map(item => `«${item.name}»`).join(', ');

interface Line { c: string; b: string; s: string }

function preLine(b: UpBoard): Line {
    if (!b.online) return { c: 'is-off', b: 'Офлайн', s: 'будет пропущена' };
    if (!b.updater) return { c: 'is-err', b: 'Нет службы обновления', s: 'поставьте пакет через install.sh' };
    if (b.busy) return { c: '', b: 'Занята', s: 'идёт операция обновления' };
    return { c: 'is-ok', b: 'Готова', s: 'служба обновления на месте' };
}

function runLine(row: UpRow, r: UpRollout, pending: boolean): Line {
    const update = r.kind === 'update';
    if (row.skipped || !row.steps) {
        return r.phase === 'done'
            ? { c: 'is-off', b: update ? 'Не обновлена' : 'Не возвращена', s: update ? 'была офлайн, нужен файл от её версии или полный' : 'была офлайн' }
            : { c: 'is-off', b: 'Пропущена', s: 'офлайн' };
    }
    const steps = row.steps;
    if (row.error) {
        if (row.lost) return { c: 'is-err', b: 'Нет связи', s: pending ? `вернётся на ${r.from_label} сама, когда появится` : row.error };
        return { c: 'is-err', b: steps.check === 'fail' ? 'Проверка не пройдена' : 'Сбой', s: row.error };
    }
    if (steps.install === 'back' || steps.master === 'back') return { c: 'is-back', b: 'Возвращена', s: `на ${r.from_label}` };
    const running = STEPS.find(([id]) => steps[id] === 'run');
    if (running) {
        const [id] = running;
        if (id === 'delivery') {
            const p = row.progress;
            return { c: '', b: 'Доставка', s: p && p.total ? `${formatBytes(p.sent)} из ${formatBytes(p.total)}` : 'приём файла' };
        }
        if (id === 'install') return { c: '', b: update ? 'Установка' : 'Возврат', s: 'службы платы перезапускаются' };
        if (id === 'master') return { c: '', b: 'Часть мастера', s: 'перезапуск служб мастера' };
        return { c: '', b: 'Проверка', s: 'контейнеры, ядро и конфигурация' };
    }
    if (STEPS.every(([id]) => steps[id] === 'ok' || steps[id] === 'na')) return { c: 'is-ok', b: update ? 'Обновлена' : 'Возвращена', s: '' };
    if (['rollback', 'rolled_back', 'failed', 'cancelled'].includes(r.phase)) return { c: '', b: 'Без изменений', s: 'установка не начиналась' };
    if (steps.check === 'ok') return { c: 'is-ok', b: 'Проверена', s: 'ждёт мастер' };
    if (steps.delivery === 'ok' && steps.install === 'wait') return { c: 'is-ok', b: 'Доставлено', s: 'ждёт остальные платы' };
    return { c: '', b: 'Ждёт', s: '' };
}

function stepWord(row: UpRow, id: StepId): [string, string] {
    const value = row.steps![id];
    if (id === 'delivery' && value === 'run' && row.progress?.total) {
        return ['is-run', `${Math.round(row.progress.sent / row.progress.total * 100)} %`];
    }
    return WORD[value];
}

interface CardProps {
    b: UpBoard;
    row: UpRow | null;
    line: Line;
    system: string | null;
    onLog: (id: string) => void;
}

function BoardCard({ b, row, line, system, onLog }: CardProps) {
    const bad = line.c === 'is-err';
    return (
        <div className={`up-card${b.online ? '' : ' is-off'}${bad ? ' is-bad' : ''}`}>
            <div className="up-card-h">
                <span className="up-nm">
                    <b><i className={`dot${b.online ? ' ok' : ''}`} />{b.name}</b>
                    <small>{b.ip}</small>
                </span>
                {bad && b.updater && (
                    <button type="button" className="icon-btn" aria-label="Журнал платы" data-tip="Журнал платы" onClick={() => onLog(b.id)}>
                        <Icon name="list" size={15} />
                    </button>
                )}
            </div>
            <div className="up-kvs">
                <span className="k">Роль</span>
                <span className="v">{b.master ? 'мастер и исполнитель' : 'исполнитель'}</span>
                <span className="k">Версия</span>
                <span className={`v${b.updater && b.version !== system ? ' is-diff' : ''}`}>{b.label ?? '—'}</span>
                <span className="k">Состояние</span>
                <span className="v"><span className={`up-line ${line.c}`}><b>{line.b}</b>{line.s && <span>{line.s}</span>}</span></span>
            </div>
            {row?.steps && (
                <div className="up-tl">
                    {STEPS.map(([id, label]) => {
                        const [cls, word] = stepWord(row, id);
                        return (
                            <div key={id} className={`up-tl-i ${cls}`}>
                                <span className="pt" />
                                <span>{label}</span>
                                <span className="tm">{word}</span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

const Fact = ({ k, v }: { k: string; v: string }) => (
    <div className="up-fact"><span className="k">{k}</span><span className="v" data-tip={v}>{v}</span></div>
);

function Check({ c }: { c: UpCheck }) {
    return (
        <div className={`up-chk is-${c.level}`}>
            <Icon name={CHECK_ICON[c.level]} size={16} />
            <div><b>{c.title}</b>{c.detail && <small>{c.detail}</small>}</div>
        </div>
    );
}

function Banner({ tone, icon, title, text, action }: { tone: string; icon: IconName; title: string; text: string; action?: React.ReactNode }) {
    return (
        <div className={`banner ${tone}`} role="status">
            <Icon name={icon} size={16} />
            <div className="bt"><b>{title}</b><span>{text}</span></div>
            {action}
        </div>
    );
}

// Строка сырого журнала платы: «ЧЧ:ММ:СС текст»
const logLine = (line: string): UpEvent & { tm: string } => {
    const match = /^(\d\d:\d\d:\d\d) (.*)$/.exec(line);
    const text = match ? match[2] : line;
    const level = /ошибка|код [1-9]|не удал|отвергнут/.test(text) ? 'err' : /возврат|откат/.test(text) ? 'back' : /совпадает|найдены|завершена/.test(text) ? 'ok' : '';
    return { t: 0, tm: match ? match[1] : '', text, level };
};

export default function UpdateSection() {
    const toast = useToast();
    const { state, failed, put, reload } = useUpdateState(SLOW_MS, FAST_MS);
    const [modal, setModal] = useState<'confirm' | 'revert' | null>(null);
    const [logId, setLogId] = useState<string | null>(null);
    const [log, setLog] = useState<string[] | null>(null);
    const [sending, setSending] = useState<{ name: string; sent: number; total: number } | null>(null);
    const [acting, setActing] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const picker = useRef<HTMLInputElement | null>(null);

    // Часы мастера относительно браузера: время хода считается по ним
    const offset = useRef(0);
    useEffect(() => {
        if (state) offset.current = state.now - Date.now() / 1000;
    }, [state]);
    const masterNow = () => Date.now() / 1000 + offset.current;

    // Пока мастер перезапускает службы, ответа нет; возвращение связи пишется в ход обновления
    const [local, setLocal] = useState<{ rollout: string; events: UpEvent[] }>({ rollout: '', events: [] });
    const lost = useRef(false);
    useEffect(() => {
        const id = state?.rollout?.id ?? '';
        if (failed && state?.busy) lost.current = true;
        if (!failed && lost.current && id) {
            lost.current = false;
            setLocal(prev => ({ rollout: id, events: [...(prev.rollout === id ? prev.events : []), { t: masterNow(), text: 'Связь с мастером восстановлена', level: 'ok' }] }));
        }
    }, [failed, state]);

    const [, tick] = useState(0);
    useEffect(() => {
        if (!state?.busy) return;
        const timer = window.setInterval(() => tick(n => n + 1), 1000);
        return () => window.clearInterval(timer);
    }, [state?.busy]);

    useEffect(() => {
        if (!logId) { setLog(null); return; }
        let alive = true;
        const load = () => updateApi.boardLog(logId)
            .then(result => { if (alive) setLog(result.lines); })
            .catch(() => { if (alive) setLog(lines => lines ?? []); });
        void load();
        const timer = window.setInterval(() => void load(), LOG_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [logId]);

    // Esc закрывает шторку журнала, уступая модалкам
    useEffect(() => {
        if (!logId) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isModalOpen()) setLogId(null); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [logId]);

    const act = async (action: () => Promise<UpState>, fail: string) => {
        setActing(true);
        try {
            put(await action());
        } catch (e) {
            toast(fail, message(e), 'err');
            void reload();
        } finally {
            setActing(false);
        }
    };

    const send = async (file: File) => {
        setSending({ name: file.name, sent: 0, total: file.size });
        try {
            put(await updateApi.upload(file, sent => setSending({ name: file.name, sent, total: file.size })));
        } catch (e) {
            toast('Файл не принят', message(e), 'err');
            void reload();
        } finally {
            setSending(null);
        }
    };

    if (!state) {
        return (
            <section className="screen mod-screen up-screen">
                <div className="notice">
                    <Icon name="warn" className="ico" />
                    {failed ? (
                        <>
                            <h2>Служба обновления не отвечает</h2>
                            <p>На мастере не установлена служба обновления или она остановлена. Поставьте пакет на плату мастера через install.sh.</p>
                        </>
                    ) : <h2>Загрузка…</h2>}
                </div>
            </section>
        );
    }

    const r = state.rollout;
    const file = state.file;
    const run = state.busy;
    const post = !run && !!r && ['done', 'rolled_back', 'failed'].includes(r.phase)
        && !(file && r.finished && file.uploaded > r.finished);
    const shown = run || post ? r : null;
    const rows = new Map((shown?.boards ?? []).map(row => [row.id, row]));
    const pendingIds = new Set(state.pending.map(p => p.id));
    const blocked = state.checks.some(c => c.level === 'err');
    const older = state.checks.some(c => c.title === OLDER);
    const reconnect = failed && run;

    const lines = state.boards.map(b => {
        const row = rows.get(b.id) ?? null;
        return { b, row, line: shown && row ? runLine(row, shown, pendingIds.has(b.id)) : preLine(b) };
    });

    const online = state.boards.filter(b => b.online);
    const offline = state.boards.filter(b => !b.online);
    const joined = (shown?.boards ?? []).filter(row => !row.skipped);
    const skipped = (shown?.boards ?? []).filter(row => row.skipped);
    const update = shown?.kind !== 'revert';

    let summary = `${online.length} в сети`;
    if (shown && run) summary = `${update ? 'обновляются' : 'возвращаются'} ${joined.length} из ${shown.boards.length}${skipped.length ? `, пропущено ${skipped.length}` : ''}`;
    else if (shown?.phase === 'done') summary = `${update ? 'обновлены' : 'возвращены'} ${joined.length} из ${shown.boards.length}`;
    else if (shown?.phase === 'rolled_back') summary = `возвращены на ${shown.from_label}`;
    else if (shown?.phase === 'failed') summary = 'без изменений';
    else {
        const missing = online.filter(b => !b.updater).length;
        if (missing) summary += `, на ${missing} нет службы обновления`;
        if (offline.length) summary += `, ${offline.length} офлайн`;
    }

    const spent = shown ? (shown.finished ?? masterNow()) - shown.started : 0;
    const failedRow = shown?.boards.find(row => row.error && !row.lost);
    const lostRows = (shown?.boards ?? []).filter(row => row.lost && pendingIds.has(row.id));
    const logButton = (id: string) => (
        <button type="button" className="btn btn--sm" onClick={() => setLogId(id)}>
            <Icon name="list" size={14} />
            Журнал платы
        </button>
    );

    let banner: React.ReactNode = null;
    if (reconnect) {
        banner = <Banner tone="is-warn" icon="refresh" title="Мастер перезапускает свои службы" text="Связь вернётся через несколько секунд, обновление продолжается. Ниже последние полученные данные." />;
    } else if (failed) {
        banner = <Banner tone="is-err" icon="warn" title="Служба обновления не отвечает" text="Показаны последние полученные данные." />;
    } else if (shown && post && shown.phase === 'done' && update) {
        const away = skipped.length ? ` ${names(skipped)} ${skipped.length > 1 ? 'были офлайн и не обновлены' : 'была офлайн и не обновлена'}.` : '';
        banner = <Banner tone="is-ok" icon="check" title={`Система обновлена до ${shown.target_label}`} text={`Платы прошли проверку за ${elapsedWords(spent)}.${away}`} />;
    } else if (shown && post && shown.phase === 'done') {
        banner = <Banner tone="is-ok" icon="undo" title={`Система возвращена на ${shown.target_label}`} text={`Повторное нажатие «Вернуть предыдущую версию» вернёт ${state.system.prev_label ?? 'прежнюю версию'}.`} />;
    } else if (shown && post && shown.phase === 'rolled_back' && lostRows.length) {
        banner = (
            <Banner
                tone="is-err" icon="warn" title={`Связь с ${names(lostRows)} пропала во время установки`}
                text={`Остальные платы возвращены на ${shown.from_label}. ${names(lostRows)} вернётся на эту версию сама, как только появится в сети.`}
                action={logButton(lostRows[0].id)}
            />
        );
    } else if (shown && post && shown.phase === 'rolled_back') {
        banner = (
            <Banner
                tone="is-err" icon="warn"
                title={update ? `Обновление не встало, система возвращена на ${shown.from_label}` : `Возврат не удался, система снова на ${shown.from_label}`}
                text={failedRow ? `«${failedRow.name}»: ${failedRow.error}` : 'Одна из плат не прошла проверку.'}
                action={failedRow ? logButton(failedRow.id) : undefined}
            />
        );
    } else if (shown && post && shown.phase === 'failed') {
        banner = (
            <Banner
                tone="is-err" icon="warn" title="Доставка не удалась, на платах ничего не изменилось"
                text={failedRow ? `«${failedRow.name}»: ${failedRow.error}` : 'Файл не дошёл до всех плат.'}
                action={failedRow ? logButton(failedRow.id) : undefined}
            />
        );
    }

    const events = shown
        ? [...shown.events, ...(local.rollout === shown.id ? local.events : [])].sort((a, b) => a.t - b.t)
        : [];

    let footer: React.ReactNode;
    if (run) {
        footer = shown?.phase === 'delivery'
            ? <button type="button" className="btn" disabled={acting} onClick={() => void act(updateApi.cancel, 'Обновление не отменено')}><Icon name="x" size={15} />Отменить обновление</button>
            : <button type="button" className="btn btn--acc" disabled><Icon name="refresh" size={16} />Идёт обновление</button>;
    } else if (file) {
        footer = (
            <>
                <button type="button" className="btn btn--ghost" disabled={acting || !!sending} onClick={() => void act(updateApi.remove, 'Файл не убран')}>
                    <Icon name="x" size={15} />
                    Убрать файл
                </button>
                <button type="button" className="btn btn--acc" disabled={acting || !!sending || blocked || failed} onClick={() => setModal('confirm')}>
                    <Icon name="refresh" size={16} />
                    {post ? 'Повторить' : 'Обновить систему'}
                </button>
            </>
        );
    } else {
        footer = (
            <button type="button" className="btn" disabled={acting || failed || !state.system.prev} onClick={() => setModal('revert')}>
                <Icon name="undo" size={16} />
                Вернуть предыдущую версию
            </button>
        );
    }

    const ready = online.filter(b => b.updater);
    const boardsText = `${ready.length} из ${state.boards.length}${offline.length ? `, офлайн ${names(offline)}` : ''}`;
    const disk = state.checks.find(c => c.level === 'warn' && c.title.startsWith('Нужно'));
    const logBoard = state.boards.find(b => b.id === logId);

    return (
        <section className="screen mod-screen up-screen">
            <div className="up-con">
                <div className="up-cl">
                    <div className="up-col">
                        {banner}
                        <div className="up-h">
                            <h3>Платы системы</h3>
                            <span className="n">{state.boards.length}</span>
                            <span className="end">{summary}</span>
                        </div>
                        {state.boards.length ? (
                            <div className={`up-cards${reconnect ? ' up-stale' : ''}`}>
                                {lines.map(({ b, row, line }) => (
                                    <BoardCard key={b.id} b={b} row={row} line={line} system={state.system.version} onLog={setLogId} />
                                ))}
                            </div>
                        ) : (
                            <div className="notice">
                                <Icon name="dev" className="ico" />
                                <h2>Платы не добавлены</h2>
                                <p>Добавьте платы на экране «Устройства», обновление ставится на все платы из реестра.</p>
                            </div>
                        )}
                    </div>
                </div>

                {logId ? (
                    <aside className="up-dw" aria-label="Журнал обновления платы">
                        <div className="up-dh">
                            <h2>Журнал обновления</h2>
                            <button type="button" className="x" onClick={() => setLogId(null)} aria-label="Закрыть"><Icon name="x" size={15} /></button>
                        </div>
                        <div className="up-dg">{logBoard?.name ?? logId}</div>
                        <div className="up-db">
                            {log === null ? <span className="muted">Загрузка…</span> : log.length ? (
                                <div className="up-log is-code">
                                    {log.map((raw, i) => {
                                        const item = logLine(raw);
                                        return <div key={i} className={`up-log-i${item.level ? ` is-${item.level}` : ''}`}><span className="tm">{item.tm}</span><span>{item.text}</span></div>;
                                    })}
                                </div>
                            ) : <span className="muted">Журнал пуст или плата не отвечает</span>}
                        </div>
                        <div className="up-df"><button type="button" className="btn btn--ghost" onClick={() => setLogId(null)}>Закрыть</button></div>
                    </aside>
                ) : (
                    <aside className="up-cr">
                        <div className="up-cr-scroll">
                            <div className="up-cr-g">Версия системы</div>
                            <div className="up-cr-b">
                                <div className="up-facts">
                                    <Fact k="Сейчас" v={state.system.label} />
                                    <Fact k="Предыдущая" v={state.system.prev_label ?? '—'} />
                                </div>
                            </div>

                            <div className="up-cr-g">Файл обновления</div>
                            <div className="up-cr-b">
                                {sending ? (
                                    <div className="up-drop is-busy">
                                        <span className="up-ib"><Icon name="up" size={20} /></span>
                                        <div className="t">
                                            <b>Загрузка файла</b>
                                            <span className="seps"><span>{formatBytes(sending.sent)} из {formatBytes(sending.total)}</span><span>{Math.round(sending.sent / Math.max(1, sending.total) * 100)} %</span></span>
                                        </div>
                                        <div className="dl-bar up-bar"><i style={{ width: `${sending.sent / Math.max(1, sending.total) * 100}%` }} /></div>
                                    </div>
                                ) : file && !(post && shown?.phase === 'done') ? (
                                    <>
                                        <div className="up-fh">
                                            <span className="up-ib"><Icon name="box" size={20} /></span>
                                            <div className="nm">
                                                <b>Выпуск {file.label}</b>
                                                <span>{file.kind === 'full' ? 'полный файл, все части' : `дельта, изменено ${file.changed} из ${file.total} частей`}</span>
                                            </div>
                                        </div>
                                        <div className="up-facts">
                                            <Fact k={file.kind === 'full' ? 'Подходит к' : 'Ставится поверх'} v={file.kind === 'full' ? 'любой версии' : file.base_label ?? '—'} />
                                            <Fact k="Размер" v={file.size_label} />
                                        </div>
                                        {!run && !post && state.checks.map((c, i) => <Check key={i} c={c} />)}
                                    </>
                                ) : (
                                    <div
                                        className={`up-drop${dragOver ? ' is-over' : ''}`}
                                        onDragOver={e => { if (!run) { e.preventDefault(); setDragOver(true); } }}
                                        onDragLeave={() => setDragOver(false)}
                                        onDrop={e => {
                                            e.preventDefault();
                                            setDragOver(false);
                                            const picked = e.dataTransfer.files[0];
                                            if (picked && !run) void send(picked);
                                        }}
                                    >
                                        <span className="up-ib"><Icon name="up" size={20} /></span>
                                        <div className="t">
                                            <b>Перетащите сюда файл обновления</b>
                                            <span>Дельта от текущей версии системы или полный файл</span>
                                        </div>
                                        <button type="button" className="btn btn--acc-dim" disabled={run || failed} onClick={() => picker.current?.click()}>
                                            <Icon name="file" size={16} />
                                            Выбрать файл
                                        </button>
                                        <input
                                            ref={picker}
                                            type="file"
                                            accept=".tar"
                                            hidden
                                            onChange={e => {
                                                const picked = e.target.files?.[0];
                                                e.target.value = '';
                                                if (picked) void send(picked);
                                            }}
                                        />
                                    </div>
                                )}
                            </div>

                            {shown && (
                                <>
                                    <div className="up-cr-g">Ход обновления<span className="n">{elapsed(spent)}</span></div>
                                    <div className="up-cr-b">
                                        <div className="up-log">
                                            {events.map((e, i) => (
                                                <div key={i} className={`up-log-i${e.level ? ` is-${e.level}` : ''}`}>
                                                    <span className="tm">{clock(e.t)}</span>
                                                    <span>{e.text}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                        <div className="up-cr-f">{footer}</div>
                    </aside>
                )}
            </div>

            {modal === 'confirm' && file && (
                <Modal
                    title={`Обновить систему до ${file.label}?`}
                    className="modal--confirm up-modal"
                    onClose={() => setModal(null)}
                    footer={(
                        <>
                            <button type="button" className="btn btn--ghost spacer" onClick={() => setModal(null)}>Отмена</button>
                            <button type="button" className="btn btn--acc" onClick={() => { setModal(null); void act(() => updateApi.start(true), 'Обновление не запущено'); }}>
                                <Icon name="refresh" size={16} />
                                Обновить систему
                            </button>
                        </>
                    )}
                >
                    <div className="modal-b">
                        <div>
                            <div className="kv"><span className="k">Сейчас</span><span className="v up-kvt">{state.system.label}</span></div>
                            <div className="kv"><span className="k">Станет</span><span className="v up-kvt">{file.label}</span></div>
                            <div className="kv"><span className="k">Платы</span><span className="v up-kvt">{boardsText}</span></div>
                            <div className="kv"><span className="k">Простой</span><span className="v up-kvt">1–3&nbsp;мин без записи, видео и техзрения</span></div>
                            <div className="kv"><span className="k">Место на плате</span><span className="v up-kvt">{disk ? `${disk.title.replace(/^Нужно /, '')}, архив удалит самые старые записи` : `${file.size_label}, архив не затрагивается`}</span></div>
                        </div>
                        <p className="modal-text up-mt">
                            {older ? 'Файл не новее установленной версии. ' : ''}
                            Если хотя бы одна плата не пройдёт проверку, все платы вернутся на {state.system.label}.
                        </p>
                    </div>
                </Modal>
            )}

            {modal === 'revert' && (
                <Modal
                    title={`Вернуть систему на ${state.system.prev_label}?`}
                    className="modal--confirm up-modal"
                    onClose={() => setModal(null)}
                    footer={(
                        <>
                            <button type="button" className="btn btn--ghost spacer" onClick={() => setModal(null)}>Отмена</button>
                            <button type="button" className="btn btn--acc" onClick={() => { setModal(null); void act(updateApi.revert, 'Версия не возвращена'); }}>
                                <Icon name="undo" size={16} />
                                Вернуть {state.system.prev_label}
                            </button>
                        </>
                    )}
                >
                    <div className="modal-b">
                        <div>
                            <div className="kv"><span className="k">Сейчас</span><span className="v up-kvt">{state.system.label}</span></div>
                            <div className="kv"><span className="k">Станет</span><span className="v up-kvt">{state.system.prev_label}</span></div>
                            <div className="kv"><span className="k">Платы</span><span className="v up-kvt">{boardsText}</span></div>
                            <div className="kv"><span className="k">Простой</span><span className="v up-kvt">1–2&nbsp;мин без записи, видео и техзрения</span></div>
                            <div className="kv"><span className="k">Файл</span><span className="v up-kvt">не нужен, прежняя версия хранится на платах</span></div>
                        </div>
                        <p className="modal-text up-mt">Повторное нажатие вернёт {state.system.label}.</p>
                    </div>
                </Modal>
            )}
        </section>
    );
}
