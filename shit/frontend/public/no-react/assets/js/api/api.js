/**
 * utility/api.js — Общий REST-клиент с JSON
 *
 * Используется любой страницей для запросов к серверу.
 * Не зависит от DOM.
 */
'use strict';

/**
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} path   — путь без хоста, напр. '/linker/exports'
 * @param {*} [body]      — тело (будет JSON.stringify)
 * @returns {Promise<any>} — распарсенный JSON
 * @throws {Error}         — при HTTP-ошибке
 */
export async function fetchJson(method, path, body) {
    const opts = {
        method,
        headers: { 'Accept': 'application/json' },
    };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${path}: ${res.status} ${text}`);
    }
    return res.json();
}