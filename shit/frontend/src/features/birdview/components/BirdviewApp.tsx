import { useCallback, useEffect, useRef, useState } from 'react';
import { Navbar } from './Navbar';
import type { ConnState } from './Navbar';
import { ToastProvider, useToast } from './common/Toast';
import { ConfiguratorScreen } from './configurator/ConfiguratorScreen';
import { LinkerScreen } from './linker/LinkerScreen';
import { CalibrationScreen } from './calibration/CalibrationScreen';
import { ProjectionScreen } from './projection/ProjectionScreen';
import { useBirdviewWs } from '../hooks/useBirdviewWs';
import { useEventLog } from '../hooks/useEventLog';
import { useStreamControl } from '../hooks/useStreamControl';
import { useCorrection } from '../hooks/useCorrection';
import { wsUrl } from '../constants';
import type { CalibrationCamera } from '../api/ws-types';
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

    const correction = useCorrection({ ws, log: eventLog.log, onToast: toast });

    /**
     * Смена камеры сразу поднимает поток. Стрим один на страницу, поэтому
     * выбор с любого экрана перезапускает его — иначе второй экран остался бы
     * с чужим кадром, а на проекции выбор камеры не делал бы вообще ничего.
     * Ручной контроль остаётся за кнопками планки.
     */
    const selectCamera = useCallback(
        (cam: CalibrationCamera) => {
            setCamera(cam);

            if (!correction.fits(cam)) {
                correction.select(null);
                eventLog.log(
                    `Коррекция снята: камера ${cam.width}×${cam.height} не совпадает с конфигурацией`,
                    'warn',
                );
            }

            // Новый кадр — старая коррекция к нему не относится, шлём load заново
            correction.reset();

            if (stream.streamId) stream.restart(cam);
            else stream.open(cam);
        },
        [correction, stream, eventLog],
    );

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
        </div>
    );
}
