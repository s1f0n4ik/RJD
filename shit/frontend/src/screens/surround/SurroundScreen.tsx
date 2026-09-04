import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { useSystem } from '../../app/SystemContext';
import { setSurroundStatus } from '../../app/surroundStatus';
import { getRouting } from '../../services/devices';
import { ToastProvider, useToast } from '../../features/birdview/components/common/Toast';
import { ConfirmModal } from '../../features/birdview/components/common/ConfirmModal';
import { ConfiguratorScreen } from '../../features/birdview/components/configurator/ConfiguratorScreen';
import { MappingScreen } from '../../features/birdview/components/mapping/MappingScreen';
import { LinkerScreen } from '../../features/birdview/components/linker/LinkerScreen';
import { CalibrationScreen } from '../../features/birdview/components/calibration/CalibrationScreen';
import { ProjectionScreen } from '../../features/birdview/components/projection/ProjectionScreen';
import { useBirdviewWs } from '../../features/birdview/hooks/useBirdviewWs';
import { useEventLog } from '../../features/birdview/hooks/useEventLog';
import { useStreamControl } from '../../features/birdview/hooks/useStreamControl';
import { useCorrection } from '../../features/birdview/hooks/useCorrection';
import { wsUrl } from '../../features/birdview/constants';
import { StreamPlayer } from '../../features/birdview/components/shared/StreamPlayer';
import type { StreamPlayerState } from '../../features/birdview/components/shared/StreamPlayer';
import type { CalibrationCamera, WsMessage } from '../../features/birdview/api/ws-types';
import type { ConnState, ScreenId } from '../../features/birdview/types';
import type { SessionReason } from '../../features/birdview/hooks/useBirdviewWs';
import { SURROUND_SECTIONS, isSurroundSection } from './sections';
import './surround.css';


// Длительность чужой сессии словами
function heldFor(sec: number | null): string {
    if (sec == null) return '';
    if (sec < 60) return `${sec} с`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} мин`;
    return `${Math.floor(min / 60)} ч ${min % 60} мин`;
}

function busyMessage(busy: { holder: string | null; heldForSec: number | null; timeoutSec: number | null }): string {
    const who = busy.holder ? `клиентом ${busy.holder}` : 'другим клиентом';
    const since = busy.heldForSec != null ? `, сессия держится ${heldFor(busy.heldForSec)}` : '';
    const limit = busy.timeoutSec != null ? ` Ответить нужно за ${busy.timeoutSec} с.` : '';
    return `Калибратор занят ${who}${since}. Перехват разорвёт чужую сессию и остановит идущий поток; снимки и калибровка сохранятся.${limit}`;
}

/**
 * Корень раздела «Система 360» на /surround/<подраздел>.
 *
 * Все подэкраны смонтированы одновременно, маршрут выбирает видимый: уход на
 * другой подраздел не рвёт WebRTC-сессию и не сбрасывает конфигуратор.
 * Сокет калибратора один на страницу, его делят калибровка и сборка.
 */
export default function SurroundScreen() {
    const { section = '' } = useParams();
    const navigate = useNavigate();
    const { devices } = useSystem();

    const deviceId = getRouting().birdview;
    const device = deviceId ? devices.find(d => d.id === deviceId) ?? null : null;
    const online = Boolean(device && device.status === 'online' && device.modules.includes('birdview'));

    // Модуль не назначен либо устройство молчит: раздел не поднимает сокет
    if (!online) {
        return (
            <section className="screen sv-screen">
                <div className="notice">
                    <Icon name="warn" className="ico" />
                    <h2>Система 360 недоступна</h2>
                    <p>{!deviceId ? 'Модуль birdview не назначен ни одному устройству' : device ? `Устройство ${device.name} не в сети` : 'Назначенное устройство не найдено'}</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn--acc" onClick={() => navigate('/devices')}>Открыть устройства</button>
                        <button className="btn" onClick={() => navigate('/')}>На главную</button>
                    </div>
                </div>
            </section>
        );
    }

    if (!isSurroundSection(section)) {
        return <Navigate to={`/surround/${SURROUND_SECTIONS[0].id}`} replace />;
    }

    return (
        <ToastProvider>
            <SurroundContent screen={section} />
        </ToastProvider>
    );
}

function SurroundContent({ screen }: { screen: ScreenId }) {
    const showToast = useToast();
    const eventLog = useEventLog();

    // Один идентификатор клиента на всё время жизни страницы
    const clientIdRef = useRef('web_' + Math.random().toString(16).slice(2, 10));

    const [camera, setCamera] = useState<CalibrationCamera | null>(null);
    // Актуальная камера для колбэков, не завязанных на рендер
    const cameraRef = useRef<CalibrationCamera | null>(null);
    cameraRef.current = camera;

    // Состояние плеера поднято сюда ради пилюль над кадром и сброса при смене камеры
    const [playerState, setPlayerState] = useState<StreamPlayerState | null>(null);

    // Кадр показывает активный подэкран, а сессия одна на раздел
    const [calibHost, setCalibHost] = useState<HTMLElement | null>(null);
    const [projHost, setProjHost] = useState<HTMLElement | null>(null);
    const playerBoxRef = useRef<HTMLDivElement>(null);
    const playerHomeRef = useRef<HTMLDivElement>(null);

    const toast = useCallback(
        (title: string, desc: string, type: 'ok' | 'err' | 'info') => showToast(title, desc, type),
        [showToast],
    );

    const streamIdRef = useRef<string | null>(null);

    const handleWsClose = useCallback(
        (reason: SessionReason | null, takenBy: string | null) => {
            // Отключение по кнопке и собственный отказ от перехвата оператор и так видит
            if (reason === 'manual' || reason === 'declined') return;

            if (reason === 'revoked') {
                showToast(
                    'Сессию перехватили',
                    takenBy ? `К калибратору подключился ${takenBy}` : 'К калибратору подключился другой клиент',
                    'err',
                );
                return;
            }
            if (reason === 'no-calibrator') {
                showToast('Калибратор не отвечает', 'Модуль 360 не подключён к брокеру на устройстве', 'err');
                return;
            }
            if (reason === 'timeout') {
                showToast('Время вышло', 'Ответ на вопрос о перехвате не пришёл вовремя', 'err');
                return;
            }

            showToast('Соединение потеряно', 'Сокет калибратора закрыт', 'err');
        },
        [showToast],
    );

    const ws = useBirdviewWs({
        initialUrl: wsUrl(`/signaling/cal-client/server?client=${clientIdRef.current}`),
        clientId: clientIdRef.current,
        getStreamId: () => streamIdRef.current,
        log: eventLog.log,
        onClose: handleWsClose,
        autoConnect: true,
    });

    const resetPlayer = useCallback(() => setPlayerState(null), []);

    const stream = useStreamControl({
        ws,
        clientId: clientIdRef.current,
        log: eventLog.log,
        onToast: toast,
        onStreamReset: resetPlayer,
    });

    streamIdRef.current = stream.streamId;

    const correction = useCorrection({
        ws,
        log: eventLog.log,
        onToast: toast,
        getCamera: () => cameraRef.current,
        isStreamLive: () => Boolean(streamIdRef.current),
    });

    // Камера до последней смены: если калибратор откажет, выбор надо вернуть
    const prevCameraRef = useRef<CalibrationCamera | null>(null);

    // Смена камеры сразу поднимает поток; на живом потоке уходит switch_camera
    const selectCamera = useCallback(
        (cam: CalibrationCamera) => {
            if (!correction.fits(cam)) {
                correction.select(null);
                eventLog.log(
                    `Коррекция снята: камера ${cam.width}×${cam.height} не совпадает с конфигурацией`,
                    'warn',
                );
            }

            if (stream.streamId) {
                prevCameraRef.current = camera;
                setCamera(cam);
                stream.switchCamera(cam);
                return;
            }

            prevCameraRef.current = null;
            setCamera(cam);
            stream.open(cam);
        },
        [camera, correction, stream, eventLog],
    );

    const handleSwitchCamera = useCallback(
        (msg: WsMessage) => {
            const meta = msg.meta ?? {};

            // Сторож свежести шлёт этот же тип с frames_stalled и без client: это не ответ на запрос
            if (meta.frames_stalled) {
                showToast('Камера молчит', meta.description ?? 'Кадры перестали приходить', 'err');
                eventLog.log(`Источник ${meta.camera_id ?? ''} перестал давать кадры`, 'err');
                return;
            }

            if (!msg.ret) {
                stream.settleSwitch(false, false);
                showToast('Камера не переключена', meta.description ?? 'Калибратор отказал', 'err');
                if (prevCameraRef.current) setCamera(prevCameraRef.current);
                prevCameraRef.current = null;
                return;
            }

            const restarted = Boolean(meta.pipeline_restarted);
            stream.settleSwitch(true, restarted);
            prevCameraRef.current = null;

            // Пересборка обнуляет коррекцию на сервере, при горячей смене она остаётся жить
            if (restarted) correction.reset();

            eventLog.log(
                restarted
                    ? `Камера переключена с пересборкой пайплайна: ${meta.camera_id ?? ''}`
                    : `Источник кадров сменён на лету: ${meta.camera_id ?? ''}`,
                'ok',
            );
        },
        [stream, correction, eventLog, showToast],
    );

    useEffect(() => ws.subscribe('switch_camera', handleSwitchCamera), [ws, handleSwitchCamera]);

    const wsState: ConnState =
        ws.status === 'connected' ? 'connected' : ws.status === 'connecting' ? 'connecting' : 'disconnected';

    const rtcState: ConnState = !stream.streamId
        ? 'disconnected'
        : playerState?.status === 'streaming'
          ? 'connected'
          : 'connecting';

    // Обрыв основного WS уносит с собой сессию калибратора
    useEffect(() => {
        if (ws.status !== 'disconnected') return;
        stream.reset();
        correction.reset();
    }, [ws.status]);

    // Узел плеера переезжает в активный подэкран: пересоздание рвало бы сессию
    useLayoutEffect(() => {
        const box = playerBoxRef.current;
        const home = playerHomeRef.current;
        if (!box || !home) return;

        const host = screen === 'calibration' ? calibHost : screen === 'projection' ? projHost : null;
        (host ?? home).appendChild(box);
        return () => {
            home.appendChild(box);
        };
    }, [screen, calibHost, projHost, stream.streamId]);

    // Точка у «Калибровки» в рельсе: поток идёт
    useEffect(() => {
        setSurroundStatus({ streaming: rtcState === 'connected' });
        return () => setSurroundStatus({ streaming: false });
    }, [rtcState]);

    return (
        <section className="screen sv-screen">
            {ws.busy && (
                <ConfirmModal
                    title="Калибратор занят"
                    message={busyMessage(ws.busy)}
                    confirmText="Перехватить"
                    cancelText="Отмена"
                    danger
                    onConfirm={ws.confirmTakeover}
                    onCancel={ws.declineTakeover}
                />
            )}

            <div ref={playerHomeRef} className="sv-player-home" />
            <div ref={playerBoxRef} className="sv-player">
                {stream.streamId && (
                    <StreamPlayer
                        key={`${stream.streamId}-${stream.generation}`}
                        cameraId={stream.streamId}
                        signalingUrl={wsUrl(`/signaling/client/${stream.streamId}`)}
                        collectStats={screen === 'calibration'}
                        onState={setPlayerState}
                    />
                )}
            </div>

            <CalibrationScreen
                active={screen === 'calibration'}
                ws={ws}
                wsState={wsState}
                rtcState={rtcState}
                clientId={clientIdRef.current}
                log={eventLog}
                camera={camera}
                onSelectCamera={selectCamera}
                stream={stream}
                correction={correction}
                playerState={playerState}
                onPlayerHost={setCalibHost}
            />

            <ProjectionScreen
                active={screen === 'projection'}
                ws={ws}
                log={eventLog}
                camera={camera}
                onSelectCamera={selectCamera}
                correction={correction}
                stream={stream}
                wsReady={ws.status === 'connected'}
                playerState={playerState}
                onPlayerHost={setProjHost}
            />

            <LinkerScreen active={screen === 'linker'} />
            <ConfiguratorScreen active={screen === 'configurator'} />
            <MappingScreen active={screen === 'mapping'} />
        </section>
    );
}
