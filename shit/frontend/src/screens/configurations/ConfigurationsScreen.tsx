import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { Modal, Seg } from '../../app/Modal';
import { useToast } from '../../app/Toast';
import { useRole } from '../../app/role';
import { useNeuralStatus } from '../../app/neuralStatus';
import { useSystem } from '../../app/SystemContext';
import { useDeviceClock, refreshDeviceClock } from '../../app/useDeviceClock';
import { useNavigationGuard } from '../../app/use-navigation-guard';
import { sameJson } from '../../utils/same-json';
import { configurationsApi, dictionariesOf, isIskraTable } from './api';
import { DictionariesPanel, IskraTablePanel, RsmTablePanel, settingsError, tableUsage } from './TablePanels';
import { ProfileOverview, type Vital } from './ProfileOverview';
import { ProfilePassport } from './ProfilePassport';
import { ProfileBar } from './ProfileBar';
import { ErrorsDrawer } from './ErrorsDrawer';
import {
    DeleteDialog,
    ExportDialog,
    ImportDialog,
    LoadDialog,
    ResetPassportDialog,
    UpdatePassportDialog,
    VersionsDialog,
} from './ProfileDialogs';
import { describeBroken, passportDifferences } from './profile-model';
import { scrollInside } from './scroll';
import {
    effectiveDefinition,
    entries,
    libraryApi,
    LibraryRequestError,
    modelCatalog,
    passportChanges,
    profileRules,
    timezoneLabel,
    type CameraSource,
    type ConfigStatus,
    type Definition,
    type Profile,
    type Source,
    type SlotSource,
    type Workspace,
} from './library-api';
import { CONFIG_SECTIONS, isConfigSection } from './sections';
import './configurations.css';
import './library.css';

const keepsDraft = (path: string) => /^(?:\/app)?\/configurations(?:\/|$)/.test(path);
const PHASES = {
    stopping: 'Остановка модулей',
    loading: 'Загрузка конфигурации',
    starting: 'Запуск модулей',
    repairing: 'Исправление паспорта',
    complete: '',
};
const STEPS = ['stopping', 'loading', 'starting'] as const;
const failureText = (failure: unknown) => (failure instanceof Error ? failure.message : 'Ошибка запроса');

function ConfigurationFailure({
    error,
    profileName,
    onRetry,
}: {
    error?: Error | null;
    profileName?: string;
    onRetry: () => void;
}) {
    const status = error instanceof LibraryRequestError ? error.status : null;
    const message = !profileName
        ? 'Не удалось получить данные от сервера мастера.'
        : status === 404
          ? 'Данные профиля недоступны. Повторите запрос или выберите другой профиль.'
          : status === 401 || status === 403
            ? 'Недостаточно прав для просмотра профиля.'
            : status && status >= 500
              ? 'Сервер не смог загрузить профиль. Попробуйте ещё раз.'
              : 'Нет ответа от сервера мастера.';
    return (
        <div className="notice lb-failure" role="alert" aria-labelledby="lb-failure-title">
            <Icon name="warn" className="ico" />
            <h2 id="lb-failure-title">{profileName ? 'Не удалось загрузить профиль' : 'Конфигурации недоступны'}</h2>
            <p>{message}</p>
            <button className="btn btn--acc" onClick={onRetry}>
                Повторить
            </button>
        </div>
    );
}

type Dialog = 'import' | 'export' | 'load' | 'delete' | 'versions' | 'update' | 'reset' | null;

export default function ConfigurationsScreen() {
    const section = useParams().section ?? '';
    const navigate = useNavigate();
    const [profiles, setProfiles] = useState<Profile[]>([]);
    const [selected, setSelected] = useState('');
    const [active, setActive] = useState<string | null>(null);
    const [status, setStatus] = useState<ConfigStatus | null>(null);
    const [workspace, setWorkspace] = useState<Workspace | null>(null);
    const [draft, setDraft] = useState<Definition>({});
    const [resets, setResets] = useState<Set<string>>(new Set());
    const [ready, setReady] = useState(false);
    const [offline, setOffline] = useState(false);
    const [loadError, setLoadError] = useState<Error | null>(null);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<(() => void) | null>(null);
    const [dialog, setDialog] = useState<Dialog>(null);
    const [drawer, setDrawer] = useState(false);
    const [errorIndex, setErrorIndex] = useState(-1);
    const [jump, setJump] = useState<number | null>(null);
    const [mappingMode, setMappingMode] = useState(section === 'dict' ? 'dictionaries' : 'mapping');
    const [reload, setReload] = useState(0);
    const alive = useRef(true);
    const currentContext = useRef('');
    const request = useRef(0);
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const { devices, cameras: liveCameras, connected } = useSystem();
    const neural = useNeuralStatus();
    const { source: clockSource } = useDeviceClock();
    const admin = useRole() === 'admin';
    const toast = useToast();
    const changes = useMemo(
        () => (workspace ? passportChanges(workspace, draft, resets) : []),
        [workspace, draft, resets],
    );
    const dirty = changes.length > 0;
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    const selectedVersion = profiles.find((profile) => profile.id === selected)?.version_id;

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            request.current++;
        };
    }, []);

    useEffect(() => {
        let stopped = false,
            running = false;
        const poll = async () => {
            if (running) return;
            running = true;
            try {
                const [list, state] = await Promise.all([libraryApi.profiles(), libraryApi.status()]);
                if (stopped) return;
                currentContext.current = state.context;
                setProfiles((previous) => (sameJson(previous, list.profiles) ? previous : list.profiles));
                setActive(list.active);
                setStatus((previous) => (sameJson(previous, state) ? previous : state));
                setOffline(false);
                setReady(true);
                setSelected((previous) =>
                    dirtyRef.current || list.profiles.some((profile) => profile.id === previous)
                        ? previous
                        : list.active || list.profiles[0]?.id || '',
                );
            } catch {
                if (!stopped) {
                    setOffline(true);
                    setReady(true);
                }
            } finally {
                running = false;
            }
        };
        void poll();
        const timer = window.setInterval(poll, 2500);
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [reload]);

    useEffect(() => {
        if (!selected || dirtyRef.current || !status) return;
        const token = ++request.current;
        setWorkspace((previous) =>
            previous?.profile.id === selected && previous.profile.version_id === selectedVersion ? previous : null,
        );
        setLoadError(null);
        libraryApi
            .workspace(selected)
            .then((result) => {
                if (
                    !alive.current ||
                    request.current !== token ||
                    dirtyRef.current ||
                    selectedRef.current !== result.profile.id ||
                    result.context !== currentContext.current
                )
                    return;
                setWorkspace((previous) => (sameJson(previous, result) ? previous : result));
                setDraft(structuredClone(effectiveDefinition(result)));
                setResets(new Set());
            })
            .catch((error) => {
                if (alive.current && request.current === token)
                    setLoadError(error instanceof Error ? error : new Error('Ошибка запроса'));
            });
        return () => {
            if (request.current === token) request.current++;
        };
    }, [selected, selectedVersion, status?.context, status?.transition?.phase, reload]);

    const guard = useCallback(
        (action: () => void) => {
            if (dirty) setPending(() => action);
            else action();
        },
        [dirty],
    );
    const { cancelNavigation } = useNavigationGuard(dirty, guard, keepsDraft);
    const transition = status?.transition;
    const transitioning = !!transition && transition.phase !== 'complete';
    const repairing = transition?.phase === 'repairing' && transition.profile_id === selected;
    const stale =
        !!workspace && (workspace.context !== status?.context || workspace.profile.version_id !== selectedVersion);
    const lockReason = !admin
        ? 'Нужны права администратора'
        : offline
          ? 'Нет связи с мастером'
          : transitioning && !repairing
            ? 'Идёт загрузка профиля'
            : busy
              ? 'Выполняется операция'
              : stale || loadError
                ? 'Профиль изменился, обновите данные'
                : '';
    const locked = !!lockReason;
    const rules = workspace ? profileRules(workspace, draft) : { id: '', settings: null };
    const catalog = useMemo(() => modelCatalog(draft), [draft]);
    // Нейроконфигурации, у которых паспорт меняет саму конфигурацию или её соответствия мастера
    const passportModels = useMemo(() => {
        const ids = new Set<string>();
        if (!workspace) return ids;
        for (const [id, entry] of Object.entries(workspace.entities.neural_config ?? {})) if (entry.state !== 'profile') ids.add(id);
        type Table = { models?: Record<string, unknown>; danger_override?: Record<string, unknown> } | undefined;
        const current = rules.settings?.table as Table;
        const original = profileRules(workspace, workspace.base).settings?.table as Table;
        for (const field of ['models', 'danger_override'] as const)
            for (const id of new Set([...Object.keys(current?.[field] ?? {}), ...Object.keys(original?.[field] ?? {})]))
                if (!sameJson(current?.[field]?.[id], original?.[field]?.[id])) ids.add(id);
        return ids;
    }, [workspace, rules.settings]);
    const cameras = useMemo(
        () =>
            entries<CameraSource>(draft, 'camera')
                .filter(([, camera]) =>
                    Object.values(camera.streams ?? {}).some((stream) => stream.purposes?.includes('neural')),
                )
                .map(([id, camera]) => ({
                    id,
                    name: camera.camera.display_name || id,
                    device: camera.place,
                })),
        [draft],
    );
    const error = settingsError(rules.settings?.dictionaries);
    const effective = useMemo(() => (workspace ? effectiveDefinition(workspace) : {}), [workspace]);
    const broken = useMemo(() => describeBroken(workspace?.broken ?? [], effective), [workspace, effective]);
    const differences = useMemo(() => (workspace ? passportDifferences(workspace) : []), [workspace]);

    const update = (kind: string, key: string, body: Source) => {
        setDraft((previous) => ({ ...previous, [kind]: { ...previous[kind], [key]: body } }));
        setResets((previous) => {
            const next = new Set(previous);
            next.delete(`${kind}/${key}`);
            return next;
        });
    };
    const reset = (kind: string, key: string) => {
        if (!workspace) return;
        setDraft((previous) => {
            const items = { ...previous[kind] };
            if (workspace.base[kind]?.[key]) items[key] = structuredClone(workspace.base[kind][key]);
            else delete items[key];
            return { ...previous, [kind]: items };
        });
        setResets((previous) => new Set(previous).add(`${kind}/${key}`));
    };
    const discard = () => {
        request.current++;
        if (workspace) setDraft(structuredClone(effectiveDefinition(workspace)));
        setResets(new Set());
        setReload((value) => value + 1);
    };
    // Снимок мастера после записи: экран, черновик и часы устройства берут его как есть
    const applySnapshot = (snapshot: Workspace) => {
        const next = { ...snapshot, rules_defaults: workspace?.rules_defaults ?? {} };
        setWorkspace(next);
        setDraft(structuredClone(effectiveDefinition(next)));
        setResets(new Set());
        void refreshDeviceClock();
    };
    const save = async (): Promise<boolean> => {
        if (!workspace || locked || error || !changes.length) return false;
        const context = workspace.context,
            id = workspace.profile.id;
        setBusy(true);
        request.current++;
        try {
            const result = await libraryApi.save(workspace, changes);
            if (!alive.current || context !== currentContext.current || id !== selectedRef.current) return false;
            applySnapshot(result.snapshot);
            toast(
                result.application_error ? 'Паспорт сохранён; применение не завершено' : 'Паспорт сохранён',
                result.application_error || '',
                result.application_error ? 'err' : 'ok',
            );
            return true;
        } catch (failure) {
            if (alive.current) toast('Не удалось сохранить паспорт', failureText(failure), 'err');
            return false;
        } finally {
            if (alive.current) setBusy(false);
        }
    };
    // Действие над паспортом в одну запись: «Оставить своё» после выхода новой версии профиля
    const keep = async (kind: string, key: string) => {
        if (!workspace || locked || dirty) return;
        setBusy(true);
        request.current++;
        try {
            const result = await libraryApi.save(workspace, [{ kind, key, keep: true }]);
            if (alive.current) {
                applySnapshot(result.snapshot);
                toast('Значение паспорта оставлено', 'Новая версия профиля принята для этой записи', 'ok');
            }
        } catch (failure) {
            if (alive.current) toast('Не удалось оставить значение', failureText(failure), 'err');
        } finally {
            if (alive.current) setBusy(false);
        }
    };
    const resetAll = async () => {
        if (!workspace) return;
        request.current++;
        const result = await libraryApi.resetPassport(workspace);
        if (!alive.current) return;
        setDialog(null);
        if (result.snapshot) {
            applySnapshot(result.snapshot);
            toast(
                result.application_error ? 'Паспорт сброшен; применение не завершено' : 'Паспорт сброшен к профилю',
                result.application_error || `Возвращено записей: ${result.removed.length}`,
                result.application_error ? 'err' : 'ok',
            );
        } else {
            if (result.transition) setStatus((previous) => (previous ? { ...previous, transition: result.transition! } : previous));
            setReload((value) => value + 1);
            toast('Паспорт сброшен к профилю', 'Профиль загружается заново', 'ok');
        }
    };
    const activate = async () => {
        setDialog(null);
        setBusy(true);
        request.current++;
        try {
            const result = await libraryApi.activate(selected);
            if (alive.current) {
                setStatus((previous) => (previous ? { ...previous, transition: result.transition } : previous));
                setReload((value) => value + 1);
            }
        } catch (failure) {
            if (alive.current) toast('Не удалось загрузить профиль', failureText(failure), 'err');
        } finally {
            if (alive.current) setBusy(false);
        }
    };
    const removeProfile = async () => {
        const id = selected;
        await libraryApi.removeProfile(id);
        if (!alive.current) return;
        setDialog(null);
        setSelected(active && active !== id ? active : '');
        setWorkspace(null);
        setReload((value) => value + 1);
        toast('Профиль удалён', profile ? `«${profile.name}», версий: ${profile.versions.length}` : '', 'ok');
    };
    const selectVersion = async (versionId: number) => {
        const result = await libraryApi.selectVersion(selected, versionId);
        if (!alive.current) return;
        if (result.transition) setStatus((previous) => (previous ? { ...previous, transition: result.transition! } : previous));
        setDialog(null);
        setReload((value) => value + 1);
        toast('Версия профиля выбрана', result.transition ? 'Профиль загружается заново' : '', 'ok');
    };
    const removeVersion = async (versionId: number) => {
        await libraryApi.removeVersion(selected, versionId);
        if (alive.current) setReload((value) => value + 1);
    };
    const recover = async (action: 'repair' | 'retry', profileId?: string) => {
        if (!transition) return;
        setBusy(true);
        try {
            await configurationsApi.recover(action, transition.id, profileId);
            if (alive.current) {
                if (action === 'repair') setSelected(transition.profile_id);
                setReload((value) => value + 1);
            }
        } catch (failure) {
            if (alive.current) toast('Ошибка восстановления', failureText(failure), 'err');
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    // Переход к записи с ошибкой: шторка закрывается, лента прокручивается, строка вспыхивает
    const showError = (index: number) => {
        setErrorIndex(index);
        setDrawer(false);
        setJump(index);
        if (section !== 'overview') navigate('/configurations/overview');
    };
    useEffect(() => {
        if (jump === null || section !== 'overview' || !workspace) return;
        const item = broken[jump];
        if (!item) {
            setJump(null);
            return;
        }
        const frame = requestAnimationFrame(() => {
            setJump(null);
            const element = document.getElementById(item.target) ?? document.getElementById(`lb-${item.section}`);
            if (!element) return;
            scrollInside(element, 'center');
            element.classList.remove('flash');
            void element.offsetWidth;
            element.classList.add('flash');
        });
        return () => cancelAnimationFrame(frame);
    }, [jump, section, workspace, broken]);

    if (!isConfigSection(section))
        return (
            <Navigate
                to={section === 'dict' || section === 'table' ? '/configurations/mapping' : '/configurations/overview'}
                replace
            />
        );

    const profile = profiles.find((item) => item.id === selected);
    const isActive = selected === active;
    const activeProfile = profiles.find((item) => item.id === active);
    const ownBindings = [
        ...new Set(Object.values(effective.binding ?? {}).map((binding) => String(binding.device_id)).filter(Boolean)),
    ];
    const onlineBindings = ownBindings.filter((id) => devices.some((device) => device.id === id && device.status === 'online'));
    const deliveryError = status?.devices.find((device) => device.state === 'error')?.error;
    const cameraProblem = entries<CameraSource>(effective, 'camera').some(([id, camera]) =>
        Object.entries(camera.streams ?? {}).some(
            ([key, stream]) =>
                stream.purposes?.some((purpose) => purpose !== 'view') &&
                liveCameras.find((item) => item.id === id)?.streams?.[key]?.status !== 3,
        ),
    );
    const neuralProblem = entries<SlotSource>(effective, 'neural_slot').some(
        ([, slot]) =>
            !neural?.some(
                (device) =>
                    device.device_id === effective.binding?.[slot.place]?.device_id &&
                    device.slots?.some(
                        (item) =>
                            item.config_id === slot.config_id && item.stream_id === slot.stream_id && item.running,
                    ),
            ),
    );
    const health = offline
        ? ['err', 'Нет связи', 'Показаны последние данные']
        : transitioning
          ? [transition.error ? 'err' : 'warn', PHASES[transition.phase], transition.error || 'Рабочие модули остановлены на время загрузки']
          : !isActive
            ? ['', 'Не загружен', activeProfile ? `Работает: ${activeProfile.name}` : 'Нет загруженного профиля']
            : broken.length
              ? ['warn', 'Применён', 'Есть ошибки ссылок']
              : deliveryError
                ? ['err', 'Ошибка применения', deliveryError]
                : ownBindings.length > onlineBindings.length
                  ? ['warn', 'Не все устройства', 'Проверьте привязки устройств']
                  : !connected
                    ? ['warn', 'Нет состояния модулей', 'Нет потока состояния медиасервиса']
                    : cameraProblem || neuralProblem
                      ? ['warn', 'Модули запущены не все', cameraProblem ? 'Проверьте камеры' : 'Проверьте слоты технического зрения']
                      : status?.devices.length && status.devices.every((device) => device.state === 'ok')
                        ? ['ok', 'Применён', 'Камеры и слоты доступны']
                        : ['', 'Проверка применения', 'Подтверждение устройств ещё не получено'];
    const conflicts = differences.filter((item) => item.conflict).length;
    const clockLabel =
        isActive && clockSource
            ? { can: 'Шина CAN', modbus: 'АС КРСПС / Modbus', ntp: 'Часы шлюза / NTP', server: 'Часы сервера' }[clockSource]
            : undefined;
    const vitals: Vital[] = [
        {
            key: 'apply',
            label: 'Применение',
            value: (
                <>
                    {health[0] === 'ok' && <i className="dot ok" />}
                    {health[1]}
                </>
            ),
            sub: health[2],
            tone: (health[0] === 'info' ? '' : health[0]) as Vital['tone'],
            text: true,
        },
        {
            key: 'broken',
            label: 'Ошибки ссылок',
            value: broken.length,
            sub: broken.length ? 'Открыть список' : 'Все ссылки целы',
            tone: broken.length ? 'err' : 'ok',
            onClick: broken.length ? () => setDrawer(true) : undefined,
        },
        {
            key: 'passport',
            label: 'Изменения паспорта',
            value: differences.length,
            sub: differences.length ? 'Отличия от профиля' : 'Совпадает с профилем',
            tone: '',
            onClick: () => navigate('/configurations/passport'),
        },
        ...(conflicts
            ? [
                  {
                      key: 'conflicts',
                      label: 'Конфликты с новой версией',
                      value: conflicts,
                      sub: 'Профиль изменил переопределённое',
                      tone: 'warn' as const,
                      onClick: () => navigate('/configurations/passport'),
                  },
              ]
            : []),
        {
            key: 'devices',
            label: 'Устройства',
            value: offline || !ownBindings.length ? '–' : `${onlineBindings.length} / ${ownBindings.length}`,
            sub: offline ? 'Нет данных' : ownBindings.length ? 'в сети' : 'Привязок нет',
            tone: '',
        },
        {
            key: 'time',
            label: 'Время',
            value: timezoneLabel(Number(effective.machine?.settings?.tz_offset_min ?? 180)),
            sub: clockLabel || 'Определяется при запуске',
            tone: '',
        },
    ];

    const stepIndex = transition ? Math.max(0, STEPS.indexOf(transition.phase as (typeof STEPS)[number])) : 0;
    const notices: ReactNode[] = [];
    if (offline)
        notices.push(
            <div className="banner is-err" role="status" key="offline">
                <Icon name="warn" size={16} />
                <b>Нет связи с мастером</b>
                <span>Показаны последние данные. Редактирование временно недоступно.</span>
                <div className="acts">
                    <button className="btn btn--sm" onClick={() => setReload((value) => value + 1)}>
                        Повторить
                    </button>
                </div>
            </div>,
        );
    if (!admin)
        notices.push(
            <div className="banner is-info" role="status" key="readonly">
                <Icon name="lock" size={16} />
                <b>Только просмотр</b>
                <span>Менять и загружать профили может администратор.</span>
            </div>,
        );
    if (stale && dirty)
        notices.push(
            <div className="banner" role="status" key="stale">
                <Icon name="warn" size={16} />
                <b>Профиль изменился. Черновик сохранён на экране</b>
                <span>Сохранение заблокировано</span>
                <div className="acts">
                    <button className="btn btn--sm" onClick={() => guard(discard)}>
                        Обновить
                    </button>
                </div>
            </div>,
        );
    if (loadError && workspace)
        notices.push(
            <div className="banner is-err" role="status" key="load-error">
                <Icon name="warn" size={16} />
                <b>Не удалось обновить профиль</b>
                <span>Показаны последние данные</span>
                <div className="acts">
                    <button className="btn btn--sm" onClick={() => setReload((value) => value + 1)}>
                        Повторить
                    </button>
                </div>
            </div>,
        );
    if (transitioning)
        notices.push(
            <div className={`lb-trans${transition.error ? ' is-fail' : ''}`} role={transition.error ? 'alert' : 'status'} key="transition">
                <b>
                    {transition.error ? 'Не удалось загрузить профиль' : 'Загрузка профиля'} «
                    {profiles.find((item) => item.id === transition.profile_id)?.name || transition.profile_id}»
                </b>
                <div className="steps">
                    {STEPS.map((step, index) => (
                        <span key={step} style={{ display: 'contents' }}>
                            {index > 0 && <span className="step-line" />}
                            <span className={`step ${index < stepIndex ? 'is-done' : index === stepIndex ? (transition.error ? 'is-fail' : 'is-on') : ''}`}>
                                <span className="n">{index < stepIndex ? '✓' : index + 1}</span>
                                {PHASES[step]}
                            </span>
                        </span>
                    ))}
                </div>
                {(transition.error || repairing) && (
                    <div className="lb-trans-f">
                        {transition.error && <span>{transition.error}</span>}
                        {admin && (
                            <span className="acts">
                                <button className="btn btn--sm" disabled={busy || dirty} onClick={() => recover('repair')}>
                                    Исправить паспорт
                                </button>
                                <button className="btn btn--sm" disabled={busy || dirty} onClick={() => recover('retry')}>
                                    Повторить переход
                                </button>
                                {transition.previous_profile_id && (
                                    <button
                                        className="btn btn--sm"
                                        disabled={busy || dirty}
                                        onClick={() => recover('retry', transition.previous_profile_id!)}
                                    >
                                        Загрузить прежний профиль
                                    </button>
                                )}
                            </span>
                        )}
                    </div>
                )}
            </div>,
        );
    const noticeBlock = notices.length ? <div className="lb-notices">{notices}</div> : null;
    const showFooter = !!workspace && (section !== 'overview' || dirty);

    return (
        <section className="screen mod-screen cf-screen lb-screen">
            <nav className="lb-compact-nav" aria-label="Разделы конфигурации">
                <div className="subnav">
                    {CONFIG_SECTIONS.map((item) => (
                        <NavLink
                            className={({ isActive: on }) => `sub${on ? ' is-on' : ''}`}
                            key={item.id}
                            to={`/configurations/${item.id}`}
                        >
                            {item.label}
                        </NavLink>
                    ))}
                </div>
            </nav>
            {profile && (
                <ProfileBar
                    profiles={profiles}
                    selected={selected}
                    lock={lockReason}
                    menuLocked={offline || (transitioning && !repairing)}
                    switching={busy || transitioning}
                    dirty={dirty}
                    onPick={(id) => guard(() => setSelected(id))}
                    onImport={() => setDialog('import')}
                    onLoad={() => guard(() => setDialog('load'))}
                    onUpdate={() => setDialog('update')}
                    onExport={() => setDialog('export')}
                    onVersions={() => setDialog('versions')}
                    onDelete={() => setDialog('delete')}
                />
            )}
            <div className="lb-view">
                {!ready ? (
                    <div className="mod-loading" role="status">
                        <span className="spin" />
                        Загрузка профилей
                    </div>
                ) : !profiles.length && offline ? (
                    <ConfigurationFailure onRetry={() => setReload((value) => value + 1)} />
                ) : !profiles.length ? (
                    <div className="lb-empty lb-empty-stage">
                        <Icon name="kit" size={40} />
                        <h2>Профилей ещё нет</h2>
                        <p>
                            Профиль хранит камеры, нейросети, зоны и настройки машины. Его готовит программист и передаёт
                            файлом: импортируйте файл профиля, чтобы начать работу.
                        </p>
                        <button className="btn btn--acc" disabled={!admin} onClick={() => setDialog('import')}>
                            <Icon name="down" size={16} />
                            Импорт
                        </button>
                    </div>
                ) : loadError && !workspace ? (
                    <ConfigurationFailure
                        error={loadError}
                        profileName={profile?.name || selected}
                        onRetry={() => setReload((value) => value + 1)}
                    />
                ) : !workspace ? (
                    <div className="lb-skel" role="status" aria-label="Загрузка конфигурации">
                        {[0, 1, 2].map((index) => (
                            <div className="card" key={index}>
                                <div className="skel" style={{ width: '30%' }} />
                                <div className="skel" style={{ width: '90%' }} />
                                <div className="skel" style={{ width: '76%' }} />
                                <div className="skel" style={{ width: '84%' }} />
                            </div>
                        ))}
                    </div>
                ) : section === 'overview' ? (
                    <ProfileOverview
                        key={workspace.profile.id}
                        workspace={workspace}
                        definition={effective}
                        timeSource={clockLabel}
                        errors={broken}
                        vitals={vitals}
                        notices={noticeBlock}
                        onError={(index) => {
                            setErrorIndex(index);
                            setDrawer(true);
                        }}
                    />
                ) : (
                    <>
                        {noticeBlock}
                        <fieldset className="lb-editable" disabled={locked}>
                            {section === 'passport' ? (
                                <ProfilePassport
                                    workspace={workspace}
                                    draft={draft}
                                    devices={devices}
                                    locked={locked}
                                    dirty={dirty}
                                    update={update}
                                    reset={reset}
                                    onKeep={(kind, key) => void keep(kind, key)}
                                    onResetAll={() => setDialog('reset')}
                                />
                            ) : (
                                <>
                                    <div className="lb-editor-toolbar">
                                        <Seg>
                                            <button
                                                className={mappingMode === 'mapping' ? 'is-on' : ''}
                                                onClick={() => setMappingMode('mapping')}
                                            >
                                                Соответствия мастера
                                            </button>
                                            <button
                                                className={mappingMode === 'dictionaries' ? 'is-on' : ''}
                                                onClick={() => setMappingMode('dictionaries')}
                                            >
                                                Словари профиля
                                            </button>
                                        </Seg>
                                        <span className="lb-map-route">
                                            Нейросеть <Icon name="chev" size={12} /> Мастер <Icon name="chev" size={12} /> АС КРСПС
                                        </span>
                                    </div>
                                    {!rules.id || !draft.integration?.[rules.id] ? (
                                        <div className="lb-empty">Интеграция АС КРСПС в этот профиль не включена</div>
                                    ) : !rules.settings?.table ? (
                                        <div className="lb-empty">Правила профиля не сохранены, мастер обнаружений недоступен</div>
                                    ) : mappingMode === 'dictionaries' ? (
                                        <DictionariesPanel
                                            value={rules.settings.dictionaries ?? {}}
                                            defaults={profileRules(workspace, workspace.base).settings?.dictionaries}
                                            usage={tableUsage(rules.settings.table, catalog)}
                                            onChange={(dictionaries) =>
                                                update('rules', rules.id, { ...rules.settings, dictionaries } as unknown as Source)
                                            }
                                        />
                                    ) : isIskraTable(rules.settings.table) ? (
                                        <IskraTablePanel
                                            passportIds={passportModels}
                                            value={rules.settings.table}
                                            onChange={(table) => update('rules', rules.id, { ...rules.settings, table } as unknown as Source)}
                                            dicts={dictionariesOf(rules.settings)}
                                            catalog={catalog}
                                            running={new Map()}
                                            cameras={cameras}
                                        />
                                    ) : (
                                        <RsmTablePanel
                                            passportIds={passportModels}
                                            value={rules.settings.table}
                                            onChange={(table) => update('rules', rules.id, { ...rules.settings, table } as unknown as Source)}
                                            dicts={dictionariesOf(rules.settings)}
                                            catalog={catalog}
                                            running={new Map()}
                                            cameras={cameras}
                                        />
                                    )}
                                </>
                            )}
                        </fieldset>
                    </>
                )}
            </div>
            {showFooter && workspace && (
                <footer className="cr-foot">
                    <span className="seps">
                        <span>{admin ? `Паспорт: ${workspace.profile.name}` : 'Только просмотр'}</span>
                        {dirty && <span className="is-warn">Изменено сущностей: {changes.length}</span>}
                        {error && <span className="is-err">{error}</span>}
                    </span>
                    <span className="spacer" />
                    <button className="btn" disabled={busy || !dirty} onClick={discard}>
                        Сбросить
                    </button>
                    <button className="btn btn--acc" disabled={locked || !dirty || !!error} onClick={() => void save()}>
                        {busy ? 'Сохранение…' : 'Сохранить'}
                    </button>
                </footer>
            )}
            {drawer && (
                <ErrorsDrawer
                    items={broken}
                    current={errorIndex}
                    onClose={() => setDrawer(false)}
                    onShow={showError}
                    onOpenModule={(to) => {
                        setDrawer(false);
                        navigate(to);
                    }}
                />
            )}
            {pending && (
                <Modal
                    title="Сохранить изменения паспорта?"
                    onClose={() => {
                        setPending(null);
                        cancelNavigation();
                    }}
                    footer={
                        <>
                            <button
                                className="btn"
                                disabled={busy}
                                onClick={() => {
                                    setPending(null);
                                    cancelNavigation();
                                }}
                            >
                                Отмена
                            </button>
                            <button
                                className="btn"
                                disabled={busy}
                                onClick={() => {
                                    setPending(null);
                                    discard();
                                    pending();
                                }}
                            >
                                Не сохранять
                            </button>
                            <button
                                className="btn btn--acc"
                                disabled={locked || !!error}
                                onClick={async () => {
                                    if (await save()) {
                                        setPending(null);
                                        pending();
                                    }
                                }}
                            >
                                Сохранить и продолжить
                            </button>
                        </>
                    }
                >
                    <div className="modal-b">Изменения относятся к паспорту профиля «{workspace?.profile.name}».</div>
                </Modal>
            )}
            {dialog === 'import' && (
                <ImportDialog
                    profiles={profiles}
                    onClose={() => setDialog(null)}
                    onImported={(title, description) => {
                        setDialog(null);
                        setReload((value) => value + 1);
                        toast(title, description, 'ok');
                    }}
                />
            )}
            {dialog === 'export' && profile && <ExportDialog profile={profile} onClose={() => setDialog(null)} />}
            {dialog === 'load' && profile && (
                <LoadDialog
                    current={activeProfile}
                    target={profile}
                    disabled={locked || dirty}
                    onClose={() => setDialog(null)}
                    onConfirm={() => void activate()}
                />
            )}
            {dialog === 'delete' && profile && (
                <DeleteDialog profile={profile} onClose={() => setDialog(null)} onConfirm={removeProfile} />
            )}
            {dialog === 'versions' && profile && (
                <VersionsDialog
                    profile={profile}
                    lock={lockReason}
                    onClose={() => setDialog(null)}
                    onSelect={selectVersion}
                    onRemove={removeVersion}
                />
            )}
            {dialog === 'update' && profile && (
                <UpdatePassportDialog
                    profile={profile}
                    onClose={() => setDialog(null)}
                    onApplied={(snapshot, count, applicationError) => {
                        setDialog(null);
                        applySnapshot(snapshot);
                        toast(
                            applicationError ? 'Паспорт обновлён; применение не завершено' : 'Паспорт обновлён',
                            applicationError || `Записано отличий: ${count}. Профиль не менялся`,
                            applicationError ? 'err' : 'ok',
                        );
                    }}
                />
            )}
            {dialog === 'reset' && workspace && (
                <ResetPassportDialog workspace={workspace} onClose={() => setDialog(null)} onConfirm={resetAll} />
            )}
        </section>
    );
}
