/**
 * birdview/state.js — Состояние приложения BirdView
 *
 * pc / rtcWs больше не здесь — ими управляют WebRTC-сессии
 * (calRtc в app.js, linkerRtc в linker.js).
 */
'use strict';

export const state = {
    clientId: 'web_' + Math.random().toString(16).slice(2, 10),
    camera:   null,    // { id, displayName, width, height, fps }
    ws:       null,    // основной WebSocket (калибровочные команды)
    streamId: null,    // id стрима, полученный от сервера
};