import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { Modal, Seg } from '../../app/Modal';
import { Select } from '../../app/Select';
import { useToast } from '../../app/Toast';
import { useRole } from '../../app/role';
import { useNeuralStatus } from '../../app/neuralStatus';
import { useSystem } from '../../app/SystemContext';
import { useDeviceClock, refreshDeviceClock } from '../../app/useDeviceClock';
import { useNavigationGuard } from '../../app/use-navigation-guard';
import { sameJson } from '../../utils/same-json';
import { configurationsApi, dictionariesOf, isIskraTable } from './api';
import { DictionariesPanel, IskraTablePanel, RsmTablePanel, settingsError, tableUsage } from './TablePanels';
import { ProfileOverview } from './ProfileOverview';
import { ProfilePassport } from './ProfilePassport';
import {
    effectiveDefinition,
    entries,
    libraryApi,
    LibraryRequestError,
    modelCatalog,
    passportChanges,
    profileRules,
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
            <h2 id="lb-failure-title">
                {profileName ? 'Не удалось загрузить профиль' : 'Конфигурации недоступны'}
            </h2>
            <p>{message}</p>
            <button className="btn btn--acc" onClick={onRetry}>Повторить</button>
        </div>
    );
}

export default function ConfigurationsScreen() {
    const section = useParams().section ?? '';
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
    const [confirmLoad, setConfirmLoad] = useState(false);
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
                setProfiles((previous) => sameJson(previous, list.profiles) ? previous : list.profiles);
                setActive(list.active);
                setStatus((previous) => sameJson(previous, state) ? previous : state);
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
                setWorkspace((previous) => sameJson(previous, result) ? previous : result);
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
    const locked = !admin || offline || !!loadError || busy || stale || (transitioning && !repairing);
    const rules = workspace ? profileRules(workspace, draft) : { id: '', settings: null };
    const catalog = useMemo(() => modelCatalog(draft), [draft]);
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
    const save = async (): Promise<boolean> => {
        if (!workspace || locked || error || !changes.length) return false;
        const context = workspace.context,
            id = workspace.profile.id;
        setBusy(true);
        request.current++;
        try {
            const result = await libraryApi.save(workspace, changes);
            if (!alive.current || context !== currentContext.current || id !== selectedRef.current) return false;
            const next = { ...result.snapshot, rules_defaults: workspace.rules_defaults };
            setWorkspace(next);
            setDraft(structuredClone(effectiveDefinition(next)));
            setResets(new Set());
            void refreshDeviceClock();
            toast(
                result.application_error ? 'Паспорт сохранён; применение не завершено' : 'Паспорт сохранён',
                result.application_error || '',
                result.application_error ? 'err' : 'ok',
            );
            return true;
        } catch (failure) {
            if (alive.current)
                toast(
                    'Не удалось сохранить паспорт',
                    failure instanceof Error ? failure.message : 'Ошибка запроса',
                    'err',
                );
            return false;
        } finally {
            if (alive.current) setBusy(false);
        }
    };
    const activate = async () => {
        setConfirmLoad(false);
        setBusy(true);
        request.current++;
        try {
            const result = await libraryApi.activate(selected);
            if (alive.current) {
                setStatus((previous) => (previous ? { ...previous, transition: result.transition } : previous));
                setReload((value) => value + 1);
            }
        } catch (failure) {
            if (alive.current)
                toast(
                    'Не удалось загрузить профиль',
                    failure instanceof Error ? failure.message : 'Ошибка запроса',
                    'err',
                );
        } finally {
            if (alive.current) setBusy(false);
        }
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
            if (alive.current)
                toast('Ошибка восстановления', failure instanceof Error ? failure.message : 'Ошибка запроса', 'err');
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    if (!isConfigSection(section))
        return (
            <Navigate
                to={section === 'dict' || section === 'table' ? '/configurations/mapping' : '/configurations/overview'}
                replace
            />
        );

    const profile = profiles.find((item) => item.id === selected);
    const isActive = selected === active;
    const pendingAction = pending;
    const profileOptions = profiles.map((item) => ({
        value: item.id,
        label: item.name,
        hint: `v${item.versions.find((version) => version.id === item.version_id)?.number ?? '?'}${item.active ? ' / Активный профиль' : ''}`,
        dot: item.active ? ('ok' as const) : undefined,
    }));
    const definition = workspace?.base ?? {};
    const ownBindings = Object.values(workspace ? (effectiveDefinition(workspace).binding ?? {}) : {}).map((binding) =>
        String(binding.device_id),
    );
    const deliveryError = status?.devices.find((device) => device.state === 'error')?.error;
    const effective = workspace ? effectiveDefinition(workspace) : {};
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
        ? ['err', 'Сервер мастера недоступен', 'Показаны последние данные']
        : transitioning
          ? [
                transition.error ? 'err' : 'warn',
                PHASES[transition.phase],
                transition.error || 'Рабочие модули остановлены на время загрузки',
            ]
          : workspace?.broken.length
            ? ['warn', 'В конфигурации есть ошибки ссылок', `${workspace.broken.length} ошибок`]
            : deliveryError
              ? ['err', 'Ошибка применения профиля', deliveryError]
              : ownBindings.some((id) => !devices.some((device) => device.id === id && device.status === 'online'))
                ? ['warn', 'Не все устройства доступны', 'Проверьте привязки устройств']
                : !connected
                  ? ['warn', 'Состояние рабочих модулей недоступно', 'Нет потока состояния медиасервиса']
                  : cameraProblem || neuralProblem
                    ? [
                          'warn',
                          'Не все рабочие модули запущены',
                          cameraProblem ? 'Проверьте камеры' : 'Проверьте слоты технического зрения',
                      ]
                    : status?.devices.length && status.devices.every((device) => device.state === 'ok')
                      ? ['', 'Профиль применён', 'Камеры и слоты доступны']
                      : ['info', 'Проверка применения профиля', 'Подтверждение устройств ещё не получено'];

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
                        <Icon name="kit" size={28} />
                        <b>Нет доступных профилей</b>
                        <span>Конфигурации ещё не загружены</span>
                        <button className="btn" onClick={() => setReload((value) => value + 1)}>
                            Обновить
                        </button>
                    </div>
                ) : (
                    <>
                        {(section !== 'overview' || !workspace) && (
                            <div className="lb-title">
                                <h2>
                                    {section === 'overview'
                                        ? profile?.name || 'Профили'
                                        : section === 'passport'
                                          ? 'Паспорт машины'
                                          : 'Словари и соответствия'}
                                </h2>
                                <Select
                                    value={selected}
                                    options={profileOptions}
                                    disabled={busy || transitioning}
                                    onChange={(id) => guard(() => setSelected(id))}
                                />
                            </div>
                        )}
                        {stale && dirty && (
                            <div className="lb-system-state lb-tone-warn">
                                <b>Профиль изменился. Черновик сохранён на экране</b>
                                <span>Сохранение заблокировано</span>
                                <button className="btn btn--sm" onClick={() => guard(discard)}>
                                    Обновить
                                </button>
                            </div>
                        )}
                        {offline && section !== 'overview' && (
                            <div className="lb-system-state lb-tone-err">
                                <b>Нет связи с мастером</b>
                                <span>Редактирование временно недоступно</span>
                            </div>
                        )}
                        {loadError && workspace && (
                            <div className="lb-system-state lb-tone-err" role="status">
                                <b>Не удалось обновить профиль</b>
                                <span>Показаны последние данные</span>
                                <button className="btn btn--sm" onClick={() => setReload((value) => value + 1)}>
                                    Повторить
                                </button>
                            </div>
                        )}
                        {loadError && !workspace ? (
                            <ConfigurationFailure
                                error={loadError}
                                profileName={profile?.name || selected}
                                onRetry={() => setReload((value) => value + 1)}
                            />
                        ) : !workspace ? (
                            <div className="mod-loading" role="status">
                                <span className="spin" />
                                Загрузка конфигурации
                            </div>
                        ) : section === 'overview' ? (
                            <div className="lb-workspace">
                                <aside className="lb-workspace-aside">
                                    <h3>Профили</h3>
                                    {profiles.map((item) => (
                                        <button
                                            key={item.id}
                                            className={`lb-profile-line${selected === item.id ? ' is-selected' : ''}`}
                                            aria-pressed={selected === item.id}
                                            disabled={busy || transitioning}
                                            onClick={() => guard(() => setSelected(item.id))}
                                        >
                                            <span>
                                                <b>{item.name}</b>
                                                <small>
                                                    {item.versions.find((version) => version.id === item.version_id)
                                                        ?.label || item.id}
                                                </small>
                                            </span>
                                            {item.active ? (
                                                <i className="lb-active-marker" aria-label="Активный профиль" />
                                            ) : (
                                                <span className="lb-version">
                                                    v
                                                    {
                                                        item.versions.find((version) => version.id === item.version_id)
                                                            ?.number
                                                    }
                                                </span>
                                            )}
                                        </button>
                                    ))}
                                    <div className="lb-profile-index">
                                        <h3>Состав профиля</h3>
                                        {[
                                            ['cameras', 'Камеры'],
                                            ['neural', 'Техническое зрение'],
                                            ['surround', 'Система 360'],
                                            ['master', 'Мастер обнаружений'],
                                            ['gateway', 'АС КРСПС'],
                                            ['display', 'Отображение и время'],
                                        ]
                                            .filter(
                                                ([id]) =>
                                                    id !== 'surround' ||
                                                    definition.projection ||
                                                    definition.calibration,
                                            )
                                            .map(([id, name]) => (
                                                <button
                                                    key={id}
                                                    onClick={() =>
                                                        document.getElementById(`lb-${id}`)?.scrollIntoView({
                                                            behavior: window.matchMedia(
                                                                '(prefers-reduced-motion: reduce)',
                                                            ).matches
                                                                ? 'auto'
                                                                : 'smooth',
                                                            block: 'start',
                                                        })
                                                    }
                                                >
                                                    {name}
                                                </button>
                                            ))}
                                    </div>
                                </aside>
                                <div className="lb-workspace-main">
                                    <div className="lb-title">
                                        <h2>{workspace.profile.name}</h2>
                                        <span className="lb-version">v{workspace.version.number}</span>
                                        <span className={`tag${isActive ? ' is-acc' : ''}`}>
                                            {isActive ? 'Активный профиль' : 'Не загружен'}
                                        </span>
                                        {!isActive && (
                                            <button
                                                className="btn btn--acc"
                                                disabled={locked}
                                                onClick={() => guard(() => setConfirmLoad(true))}
                                            >
                                                Загрузить профиль
                                            </button>
                                        )}
                                    </div>
                                    {isActive && (
                                        <div
                                            className={`lb-system-state${health[0] ? ` lb-tone-${health[0]}` : ''}`}
                                            role="status"
                                        >
                                            <i className="dot" />
                                            <b>{health[1]}</b>
                                            <span>{health[2]}</span>
                                        </div>
                                    )}
                                    <ProfileOverview
                                        key={workspace.profile.id}
                                        workspace={workspace}
                                        definition={definition}
                                        timeSource={
                                            isActive && clockSource
                                                ? {
                                                      can: 'Шина CAN',
                                                      modbus: 'АС КРСПС / Modbus',
                                                      ntp: 'Часы шлюза / NTP',
                                                      server: 'Часы сервера',
                                                  }[clockSource]
                                                : undefined
                                        }
                                    />
                                </div>
                            </div>
                        ) : (
                            <fieldset className="lb-editable" disabled={locked}>
                                {section === 'passport' ? (
                                    <ProfilePassport
                                        workspace={workspace}
                                        draft={draft}
                                        devices={devices}
                                        update={update}
                                        reset={reset}
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
                                                Нейросеть <Icon name="chev" size={12} /> Мастер{' '}
                                                <Icon name="chev" size={12} /> АС КРСПС
                                            </span>
                                        </div>
                                        {!rules.id || !draft.integration?.[rules.id] ? (
                                            <div className="lb-empty">
                                                Интеграция АС КРСПС в этот профиль не включена
                                            </div>
                                        ) : !rules.settings?.table ? (
                                            <div className="lb-empty">
                                                Правила профиля не сохранены, мастер обнаружений недоступен
                                            </div>
                                        ) : mappingMode === 'dictionaries' ? (
                                            <DictionariesPanel
                                                value={rules.settings.dictionaries ?? {}}
                                                defaults={
                                                    profileRules(workspace, workspace.base).settings?.dictionaries
                                                }
                                                usage={tableUsage(rules.settings.table, catalog)}
                                                onChange={(dictionaries) =>
                                                    update('rules', rules.id, {
                                                        ...rules.settings,
                                                        dictionaries,
                                                    } as unknown as Source)
                                                }
                                            />
                                        ) : isIskraTable(rules.settings.table) ? (
                                            <IskraTablePanel
                                                value={rules.settings.table}
                                                onChange={(table) =>
                                                    update('rules', rules.id, {
                                                        ...rules.settings,
                                                        table,
                                                    } as unknown as Source)
                                                }
                                                dicts={dictionariesOf(rules.settings)}
                                                catalog={catalog}
                                                running={new Map()}
                                                cameras={cameras}
                                            />
                                        ) : (
                                            <RsmTablePanel
                                                value={rules.settings.table}
                                                onChange={(table) =>
                                                    update('rules', rules.id, {
                                                        ...rules.settings,
                                                        table,
                                                    } as unknown as Source)
                                                }
                                                dicts={dictionariesOf(rules.settings)}
                                                catalog={catalog}
                                                running={new Map()}
                                                cameras={cameras}
                                            />
                                        )}
                                    </>
                                )}
                            </fieldset>
                        )}
                        {transitioning && (
                            <div className="lb-system-state lb-tone-warn">
                                <b>{PHASES[transition.phase]}</b>
                                <span>{transition.error || transition.profile_id}</span>
                                {admin && (transition.error || repairing) && (
                                    <>
                                        <button
                                            className="btn btn--sm"
                                            disabled={busy || dirty}
                                            onClick={() => recover('repair')}
                                        >
                                            Исправить паспорт
                                        </button>
                                        <button
                                            className="btn btn--sm"
                                            disabled={busy || dirty}
                                            onClick={() => recover('retry')}
                                        >
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
                                    </>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
            {workspace && (
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
                                    pendingAction?.();
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
                                        pendingAction?.();
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
            {confirmLoad && (
                <Modal
                    title={`Загрузить профиль «${profile?.name}»?`}
                    onClose={() => setConfirmLoad(false)}
                    footer={
                        <>
                            <button className="btn" onClick={() => setConfirmLoad(false)}>
                                Отмена
                            </button>
                            <button className="btn btn--acc" disabled={locked || dirty} onClick={() => void activate()}>
                                Подтвердить загрузку
                            </button>
                        </>
                    }
                >
                    <div className="modal-b">
                        <div className="lb-load-comparison">
                            <div>
                                <span>Сейчас</span>
                                <b>{profiles.find((item) => item.id === active)?.name || 'Не выбран'}</b>
                            </div>
                            <Icon name="chev" size={20} />
                            <div>
                                <span>После загрузки</span>
                                <b>
                                    {profile?.name} / v{workspace?.version.number}
                                </b>
                            </div>
                        </div>
                        <p>
                            Камеры, запись, техническое зрение, 360 и передача обнаружений остановятся на время
                            загрузки. После применения профиля модули запустятся снова.
                        </p>
                        <p className="lb-muted">Загрузится сохранённый паспорт этого профиля.</p>
                    </div>
                </Modal>
            )}
        </section>
    );
}
