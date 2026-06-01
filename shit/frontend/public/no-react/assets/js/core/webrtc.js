/**
 * core/webrtc.js — Единственный модуль WebRTC-подключений.
 *
 * Используется ВСЕМИ страницами (калибровка, линкер, будущие).
 * Ни один другой файл НЕ создаёт RTCPeerConnection.
 *
 * API:
 *   session = createWebRTCSession()
 *   connectWebRTC(session, { streamId, clientId, wsUrl, ...callbacks })
 *   closeWebRTC(session)
 *   wsUrl(path)          — построить ws:// / wss:// адрес
 *   main_ws_url           — адрес основного сигналинга
 */
'use strict';

// ── Helpers ──────────────────────────────────────────────────

export function wsUrl(path) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${proto}//${window.location.host}${cleanPath}`;
}

export const main_ws_url = wsUrl('/signaling/cal-client/server');

// ── Session factory ──────────────────────────────────────────

export function createWebRTCSession() {
    return {
        rtcWs:    null,
        pc:       null,
        streamId: null,
        clientId: null,
        wsUrl:    null,
        handlers: {},
    };
}

// ── Connect ──────────────────────────────────────────────────

/**
 * @param {object} session  — объект от createWebRTCSession()
 * @param {object} opts
 * @param {string}   opts.streamId
 * @param {string}   opts.clientId
 * @param {string}   opts.wsUrl
 * @param {function} [opts.onTrack]                  — MediaStream получен
 * @param {function} [opts.onIceStateChange]         — ICE state string
 * @param {function} [opts.onConnectionStateChange]  — connection state string
 * @param {function} [opts.onReady]                  — сервер подтвердил WS, PC создан
 * @param {function} [opts.onWsOpen]                 — сигналинг WS открыт
 * @param {function} [opts.onWsClose]                — сигналинг WS закрыт
 * @param {function} [opts.onError]                  — любая ошибка
 * @param {function} [opts.onClose]                  — сессия закрыта (closeWebRTC)
 */
export function connectWebRTC(session, {
    streamId, clientId, wsUrl: url,
    onTrack, onIceStateChange, onConnectionStateChange,
    onReady, onWsOpen, onWsClose,
    onError, onClose,
}) {
    closeWebRTC(session);

    session.streamId = streamId;
    session.clientId = clientId;
    session.wsUrl    = url;

    session.handlers = {
        onTrack, onIceStateChange, onConnectionStateChange,
        onReady, onWsOpen, onWsClose,
        onError, onClose,
    };

    try {
        session.rtcWs = new WebSocket(session.wsUrl.toString());
    } catch (e) {
        console.error('WS creation failed:', e);
        _emitError(session, e);
        return;
    }

    session.rtcWs.onopen    = ()    => _onWsOpen(session);
    session.rtcWs.onmessage = (ev)  => _onWsMessage(session, ev);
    session.rtcWs.onerror   = (ev)  => _onWsError(session, ev);
    session.rtcWs.onclose   = ()    => _onWsClose(session);
}

// ── Close ────────────────────────────────────────────────────

export function closeWebRTC(session) {
    _send(session, {
        type:        'close',
        client_id:   session.clientId,
        camera:      session.streamId,
        description: 'client disconnect',
    });

    if (session.rtcWs) {
        try { session.rtcWs.close(); } catch (_) {}
        session.rtcWs = null;
    }

    if (session.pc) {
        try { session.pc.close(); } catch (_) {}
        session.pc = null;
    }

    session.handlers.onClose?.();
}

// ── Internals ────────────────────────────────────────────────

function _send(session, payload) {
    if (!session.rtcWs || session.rtcWs.readyState !== WebSocket.OPEN) return;
    session.rtcWs.send(JSON.stringify(payload));
}

function _emitError(session, err) {
    session.handlers.onError?.(err);
}

// ── WS lifecycle ─────────────────────────────────────────────

function _onWsOpen(session) {
    session.handlers.onWsOpen?.();

    _send(session, {
        type:        'connection',
        client_id:   session.clientId,
        camera:      session.streamId,
        description: 'webrtc_ready',
        ret:         'none',
    });
}

function _onWsMessage(session, event) {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch (e) { _emitError(session, e); return; }

    switch (msg.type) {
        case 'connection': _handleConnection(session, msg); break;
        case 'offer':      _handleOffer(session, msg);      break;
        case 'answer':     _handleAnswer(session, msg);     break;
        case 'ice':        _handleIce(session, msg);        break;
    }
}

function _onWsError(session, e) {
    _emitError(session, e);
}

function _onWsClose(session) {
    session.handlers.onWsClose?.();
}

// ── Peer Connection ──────────────────────────────────────────

function _createPeerConnection(session) {
    session.pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'turn:172.25.78.169:3478', username: 'niac', credential: 'VniiTest' },
            { urls: 'turn:91.151.186.105:3478', username: 'niac', credential: 'VniiTest' },
        ],
    });

    session.pc.addTransceiver('video', { direction: 'recvonly' });

    session.pc.ontrack = (e) => session.handlers.onTrack?.(e);

    session.pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        _send(session, {
            type:             'ice',
            client_id:        session.clientId,
            camera:           session.streamId,
            candidate:        e.candidate.candidate,
            sdpMLineIndex:    e.candidate.sdpMLineIndex,
            sdpMid:           e.candidate.sdpMid,
            usernameFragment: e.candidate.usernameFragment,
        });
    };

    session.pc.oniceconnectionstatechange = () =>
        session.handlers.onIceStateChange?.(session.pc.iceConnectionState);

    session.pc.onconnectionstatechange = () =>
        session.handlers.onConnectionStateChange?.(session.pc.connectionState);
}

// ── Signaling handlers ───────────────────────────────────────

function _handleConnection(session, msg) {
    if (!msg.ret) { _emitError(session, msg.description); return; }
    _createPeerConnection(session);
    session.handlers.onReady?.();
}

async function _handleOffer(session, msg) {
    if (!session.pc) return;
    try {
        await session.pc.setRemoteDescription(
            new RTCSessionDescription({ type: 'offer', sdp: msg.sdp })
        );
        const answer = await session.pc.createAnswer();
        await session.pc.setLocalDescription(answer);
        _send(session, {
            type:        'answer',
            client_id:   session.clientId,
            camera:      session.streamId,
            description: 'rtc_answer',
            sdp:         answer.sdp,
        });
    } catch (e) { _emitError(session, e); }
}

async function _handleAnswer(session, msg) {
    if (!session.pc) return;
    try {
        await session.pc.setRemoteDescription(
            new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })
        );
    } catch (e) { _emitError(session, e); }
}

async function _handleIce(session, msg) {
    if (!session.pc) return;
    try {
        await session.pc.addIceCandidate(
            new RTCIceCandidate({
                candidate:     msg.candidate,
                sdpMLineIndex: msg.sdpMLineIndex,
                sdpMid:        msg.sdpMid ?? undefined,
            })
        );
    } catch (e) { _emitError(session, e); }
}