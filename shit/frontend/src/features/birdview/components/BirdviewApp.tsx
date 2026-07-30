import { useCallback, useEffect, useRef, useState } from 'react';
import { Navbar } from './Navbar';
import type { ConnState } from './Navbar';
import { ToastProvider, useToast } from './common/Toast';
import { ConfiguratorScreen } from './configurator/ConfiguratorScreen';
import { MappingScreen } from './mapping/MappingScreen';
import { LinkerScreen } from './linker/LinkerScreen';
import { CalibrationScreen } from './calibration/CalibrationScreen';
import { ProjectionScreen } from './projection/ProjectionScreen';
import { useBirdviewWs } from '../hooks/useBirdviewWs';
import { useEventLog } from '../hooks/useEventLog';
import { useStreamControl } from '../hooks/useStreamControl';
import { useCorrection } from '../hooks/useCorrection';
import { wsUrl } from '../constants';
import type { CalibrationCamera, WsMessage } from '../api/ws-types';
import type { PlayerStatusInfo } from '../../../components/WebRTCPlayer';
import type { ScreenId } from '../types';
import '../styles/theme.css';

const IDLE_PLAYER: PlayerStatusInfo = { status: 'connecting', ice: '—', conn: '—' };

/**
 * Корень страницы «Система 360».
 *
 * Все экраны смонтированы одновременно и переключаются через display — так же,
 * как в no-react это делал navigation.js. Это нужно, чтобы уход на другой экран
 * не рвал живую WebRTC-сессию и не сбрасывал состояние конфигуратора.
 *
 * Основной WebSocket и общее состояние (клиент, камера, стрим, коррекция) живут
 * здесь: их делят калибровка и проекция — диспетчер в no-react раздавал
 * сообщения между обоими экранами из одного сокета. Камеру и коррекцию теперь
 * выбирают с обоих экранов, а калибратор всё тот же один.
 */
export function BirdviewApp() {
    return (
        <ToastProvider>
            <BirdviewContent />
        </ToastProvider>
    );
}

function BirdviewContent() {
    const [screen, setScreen] = useState<ScreenId>('calibration');
    const showToast = useToast();

    const eventLog = useEventLog();

    // Один идентификатор клиента на всё время жизни страницы
    const clientIdRef = useRef('web_' + Math.random().toString(16).slice(2, 10));

    const [camera, setCamera] = useState<CalibrationCamera | null>(null);
    // Актуальная камера для колбэков, не завязанных на рендер
    const cameraRef = useRef<CalibrationCamera | null>(null);
    cameraRef.current = camera;

    // Состояние плеера поднято сюда ради пилюль в навбаре и сброса при смене камеры
    const [playerInfo, setPlayerInfo] = useState<PlayerStatusInfo>(IDLE_PLAYER);

    const toast = useCallback(
        (title: string, desc: string, type: 'ok' | 'err' | 'info') => showToast(title, desc, type),
        [showToast],
    );

    const streamIdRef = useRef<string | null>(null);

    const handleWsClose = useCallback(() => {
        showToast('Соединение потеряно', 'Основной WebSocket закрыт', 'err');
    }, [showToast]);

    const ws = useBirdviewWs({
        initialUrl: wsUrl('/signaling/cal-client/server'),
        clientId: clientIdRef.current,
        getStreamId: () => streamIdRef.current,
        log: eventLog.log,
        onClose: handleWsClose,
        autoConnect: true,
    });

    const resetPlayer = useCallback(() => setPlayerInfo(IDLE_PLAYER), []);

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

    /**
     * Смена камеры сразу поднимает поток. Стрим один на страницу, поэтому
     * выбор с любого экрана перезапускает его — иначе второй экран остался бы
     * с чужим кадром, а на проекции выбор камеры не делал бы вообще ничего.
     * Ручной контроль остаётся за кнопками планки.
     *
     * На живом потоке уходит switch_camera: калибратор подменит слот в
     * хранилище и не тронет пайплайн, если разрешение то же. Пересборку он
     * затевает сам и сообщает о ней в ответе.
     */
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

            // Сторож свежести шлёт этот же тип с признаком frames_stalled и без
            // client — это не ответ на запрос, поток при этом остаётся выбранным
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

            // Пересборка обнуляет коррекцию на сервере: карты прежнего размера
            // к новым кадрам неприменимы. При горячей смене она остаётся жить
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

    const wsPill: ConnState =
        ws.status === 'connected' ? 'connected' : ws.status === 'connecting' ? 'connecting' : 'disconnected';

    const rtcPill: ConnState = !stream.streamId
        ? 'disconnected'
        : playerInfo.status === 'connected'
          ? 'connected'
          : playerInfo.status === 'error'
            ? 'disconnected'
            : 'connecting';

    const rtcWsPill: ConnState = !stream.streamId
        ? 'disconnected'
        : playerInfo.conn === '—'
          ? 'connecting'
          : 'connected';

    // Обрыв основного WS уносит с собой сессию калибратора
    useEffect(() => {
        if (ws.status !== 'disconnected') return;
        stream.reset();
        correction.reset();
    }, [ws.status]);

    return (
        <div className="birdview-root">
            <Navbar
                screen={screen}
                onScreenChange={setScreen}
                wsState={wsPill}
                rtcWsState={rtcWsPill}
                rtcState={rtcPill}
            />

            <CalibrationScreen
                active={screen === 'calibration'}
                ws={ws}
                clientId={clientIdRef.current}
                log={eventLog}
                camera={camera}
                onSelectCamera={selectCamera}
                stream={stream}
                correction={correction}
                playerInfo={playerInfo}
                onPlayerInfo={setPlayerInfo}
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
            />

            <LinkerScreen active={screen === 'linker'} />
            <ConfiguratorScreen active={screen === 'configurator'} />
            <MappingScreen active={screen === 'mapping'} />
        </div>
    );
}
