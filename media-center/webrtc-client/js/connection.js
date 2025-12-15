const connectBtn = document.getElementById('connectBtn');
const signalingUrlInput = document.getElementById('signalingUrl');
const logsElem = document.getElementById('logs');
const remoteVideo = document.getElementById('remoteVideo');
const fullscreenBtn = document.getElementById('fullscreenBtn');

const caps = RTCRtpSender.getCapabilities("video");
console.log(caps);

let ws = null;
let pc = null;

function log(msg) {
    console.log(msg);
    logsElem.textContent += msg + '\n';
    logsElem.scrollTop = logsElem.scrollHeight;
}

function extractCameraId(url) {
    const parts = url.split('/');
    return parts[parts.length - 1];
}

function forceH264(sdp) {
    // 1. Разрешаем PT 96 в медиалинии
    sdp = sdp.replace(/m=video \d+ UDP\/TLS\/RTP\/SAVPF .+/,
        "m=video 9 UDP/TLS/RTP/SAVPF 96");

    // 2. Подменяем профиль на совместимый с Chrome
    sdp = sdp.replace(/profile-level-id=[0-9A-Fa-f]+/,
        "profile-level-id=42e01f");

    return sdp;
}

async function getClientIP() {
    try {
        const res = await fetch("https://api.ipify.org?format=json");
        const data = await res.json();
        return data.ip || "unknown";
    } catch {
        return "unknown";
    }
}

connectBtn.onclick = async () => {
    const url = signalingUrlInput.value.trim();
    if (!url) return alert("Введите URL");

    if (ws) ws.close();
    if (pc) { pc.close(); pc = null; }

    startConnection(url);
};

function createPeerConnection(clientId, cameraId) {
    log("Создаётся RTCPeerConnection...");

    pc = new RTCPeerConnection({
        //iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    pc.onicecandidate = event => {
        if (event.candidate) {
            const msg = {
                type: "ice",
                client_id: clientId,
                camera: cameraId,
                candidate: event.candidate.candidate,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                sdpMid: event.candidate.sdpMid,
                usernameFragment: event.candidate.usernameFragment,
            };
            ws.send(JSON.stringify(msg));

            log("Отправлен ICE: " + JSON.stringify({candidate: event.candidate.candidate}));
        }
    };

    pc.oniceconnectionstatechange = () => {
        log("ICE connection state: ", pc.iceConnectionState);
    };

    pc.ontrack = event => {
        log("Получен медиапоток");
        document.getElementById('remoteVideo').srcObject = event.streams[0];
    };

    pc.onconnectionstatechange = () => {
        log("Состояние соединения: " + pc.connectionState);
    };
}

async function startConnection(url) {
    const cameraId = extractCameraId(url);
    const clientId = await getClientIP();

    log(`Подключение к сигналинг серверу: ${url}`);
    log(`camera_id = ${cameraId}`);

    ws = new WebSocket(url);

    ws.onopen = async () => {
        log("WebSocket соединение установлено");

        const hello = {
            type: "connection",
            client_id: clientId,
            camera: cameraId,
            description: "connect_request from client",
            ret: "none"
        };

        ws.send(JSON.stringify(hello));
        log("Отправлен connection запрос: " + JSON.stringify(hello));
    };

    ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        log("Получено сообщение: " + JSON.stringify(msg));

        // --- ЭТАП 1: ответ камеры на connection ---
        if (msg.type === "connection") {
            if (msg.ret === "success") {
                log("Камера приняла соединение, начинаем WebRTC");
                createPeerConnection(clientId, cameraId);
            } else {
                log("Камера отказала: ret=fault");
            }
            return;
        }

        // --- ЭТАП 2: обработка WebRTC сигналинга ---
        if (msg.type === "offer") {
            log("Получен SDP offer от камеры");

            const offer = {
                type: "offer",
                //sdp: forceH264(msg.sdp)
                sdp: msg.sdp
            };

            pc.addTransceiver("video", { direction: "recvonly" });

            await pc.setRemoteDescription(new RTCSessionDescription(offer));

            log("Создаю SDP answer...");
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            const response = {
                type: "answer",
                client_id: clientId,
                camera: cameraId,
                description: "SDP answer from client",
                sdp: answer.sdp   // <-- важный момент: просто строка SDP
            };

            log("Отправляю ответ:", response);
            ws.send(JSON.stringify(response));
        }

        if (msg.type === "answer") {
            log("Получен SDP answer от камеры");

            await pc.setRemoteDescription(new RTCSessionDescription({
                type: msg.type,
                sdp: msg.sdp
            }));
        }

        if (msg.type === "ice") {
            try {
                const iceCandidateInit = {
                    candidate: msg.candidate,
                    sdpMLineIndex: msg.sdpMLineIndex,
                    sdpMid: msg.sdpMid || "video0"  // если sdpMid нет, задаём "video0" по умолчанию
                };

                await pc.addIceCandidate(new RTCIceCandidate(iceCandidateInit));
                //log("Добавлен ICE кандидат от камеры");
            } catch (err) {
                log("Ошибка при добавлении ICE кандидата: " + err);
            }
        }
    };

    ws.onerror = (err) => log("WebSocket ошибка: " + err);
    ws.onclose = () => {
        log("WebSocket соединение закрыто");
        if (pc) pc.close();
    };
}

fullscreenBtn.onclick = () => {
    if (!document.fullscreenElement) {
        if (remoteVideo.requestFullscreen) {
            remoteVideo.requestFullscreen();
        } else if (remoteVideo.mozRequestFullScreen) { /* Firefox */
            remoteVideo.mozRequestFullScreen();
        } else if (remoteVideo.webkitRequestFullscreen) { /* Chrome, Safari & Opera */
            remoteVideo.webkitRequestFullscreen();
        } else if (remoteVideo.msRequestFullscreen) { /* IE/Edge */
            remoteVideo.msRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
};
