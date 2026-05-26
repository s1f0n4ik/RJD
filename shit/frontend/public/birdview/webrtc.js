import {log} from './utility.js';

export function wsUrl(path) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${proto}//${window.location.host}${cleanPath}`;
}

export const main_ws_url = wsUrl(`/signaling/cal-client/server`);

export function createWebRTCSession() {
    return {
        rtcWs: null,
        pc:    null,

        streamId: null,
        clientId: null,
        wsUrl:    null,

        handlers: {},
    };
}

export function connectWebRTC(session, {streamId, clientId, wsUrl,
    onTrack, onIceStateChange, onConnectionStateChange, onError, onClose
}) {
    closeWebRTC(session);

    session.streamId = streamId;
    session.clientId = clientId;
    session.wsUrl = wsUrl(`/signaling/client/${streamId}`);

    session.handlers = {
        onTrack,
        onIceStateChange,
        onConnectionStateChange,
        onError,
        onClose,
    };

    log(`Try to connect to ${session.wsUrl}`);
    try {
        session.rtcWs = new WebSocket(session.wsUrl.toString());
    }
    catch (e) {
        console.error('WS creation failed:', e);
    }

    session.rtcWs.onopen = (event) => _onWsOpen(session);
    session.rtcWs.onmessage = (event) => _onWsMessage(session, event);
    session.rtcWs.onerror = (event) => _onWsError(session, event);
    session.rtcWs.onclose = (event) => _onWsClose(session);
}

export function closeWebRTC(session) {
    _send(session, {
        type:        'close',
        client_id:   session.clientId,
        camera:      session.streamId,
        description: 'client disconnect',
    });

    if (session.rtcWs) {
        try {
            session.rtcWs.close();
        } catch (_) {}

        session.rtcWs = null;
    }

    if (session.pc) {
        try {
            session.pc.close();
        } catch (_) {}

        session.pc = null;
    }

    session.handlers.onClose?.(session);
}

function _send(session, payload) {
    if (!session.rtcWs) {
        log(`Cannot send ${payload}, WS closed!`);
        return;
    }

    if (session.rtcWs.readyState !== WebSocket.OPEN) {
        log(`Cannot send ${payload}, WS not ready!`);
        return;
    }

    session.rtcWs.send(JSON.stringify(payload));
}

function _emitError(session, err) {
    session.handlers.onError?.(err);
}

function _onWsOpen(session) {
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

    try {
        msg = JSON.parse(event.data);
    }
    catch (e) {
        _emitError(session, e);
        return;
    }

    switch (msg.type) {
        case 'connection':
            _handleConnection(session, msg);
            break;
        case 'offer':
            _handleOffer(session, msg);
            break;
        case 'answer':
            _handleAnswer(session, msg);
            break;
        case 'ice':
            _handleIce(session, msg);
            break;
    }
}

function _onWsError(session, e) {
    _emitError(session, e);
}

function _onWsClose(session) {
    session.handlers.onClose?.();
}

// PEER CONNECTION
function _createPeerConnection(session) {
    session.pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls: 'turn:172.25.78.169:3478',
                username: 'niac',
                credential: 'VniiTest'
            }
        ],
    });

    session.pc.addTransceiver('video', {
        direction: 'recvonly',
    });

    session.pc.ontrack = (e) => {
        session.handlers.onTrack?.(e);
    };

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

    session.pc.oniceconnectionstatechange = () => {
        session.handlers.onIceStateChange?.(
            session.pc.iceConnectionState
        );
    };

    session.pc.onconnectionstatechange = () => {
        session.handlers.onConnectionStateChange?.(
            session.pc.connectionState
        );
    };
}

function _handleConnection(session, msg) {
    if (!msg.ret) {
        _emitError(session, msg.description);
        return;
    }

    _createPeerConnection(session);
}

async function _handleOffer(session, msg) {
    if (!session.pc) return;

    try {
        await session.pc.setRemoteDescription(
            new RTCSessionDescription({
                type: 'offer',
                sdp: msg.sdp,
            })
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
    }
    catch (e) {
        _emitError(session, e);
    }
}

async function _handleAnswer(session, msg) {
    if (!session.pc) return;

    try {
        await session.pc.setRemoteDescription(
            new RTCSessionDescription({
                type: 'answer',
                sdp: msg.sdp,
            })
        );
    }
    catch (e) {
        _emitError(session, e);
    }
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
    }
    catch (e) {
        _emitError(session, e);
    }
}