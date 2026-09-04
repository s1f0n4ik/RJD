import type { IconName } from './Icons';
import { sectionLabel } from '../screens/krsps/sections';
import { SURROUND_SECTIONS, surroundSectionLabel } from '../screens/surround/sections';

/**
 * Разделы новой оболочки.
 *
 * ready:false — раздел ещё не переписан: пункт виден, приглушён и помечен
 * «в работе», клик по нему ничего не открывает. Так структура будущего
 * приложения видна целиком, а незаконченное не притворяется работающим.
 */
export interface NavSubItem {
    to: string;
    label: string;
    /** Номер шага: подразделы — реальная последовательность настройки */
    n: string;
}

export interface NavItem {
    to: string;
    label: string;
    icon: IconName;
    ready: boolean;
    group?: string;
    /** Подпись на плитке главной, как в макете */
    desc?: string;
    /** Подсписок в рельсе, виден только в активном разделе */
    sub?: NavSubItem[];
}

export const NAV: NavItem[] = [
    { to: '/',         label: 'Главная',             icon: 'home',  ready: true },
    { to: '/cameras',  label: 'Камеры',              icon: 'cam',   ready: true,  desc: 'Источники, потоки, разрешение' },
    { to: '/live',     label: 'Отображение',         icon: 'grid',  ready: true,  desc: 'Сетки просмотра и прямой эфир' },
    { to: '/archive',  label: 'Архив',               icon: 'arch',  ready: true,  desc: 'Записи, таймлайны и склейка' },
    { to: '/devices',  label: 'Устройства',          icon: 'dev',   ready: true,  desc: 'Одноплатники: состояние и маршрутизация' },

    { to: '/neural',   label: 'Техническое зрение',  icon: 'eye',   ready: false, group: 'Модули' },
    {
        to: '/surround', label: 'Система 360', icon: '360', ready: true, desc: 'Калибровка, сборка, конфигуратор',
        sub: SURROUND_SECTIONS.map((s, i) => ({ to: `/surround/${s.id}`, label: s.label, n: String(i + 1).padStart(2, '0') })),
    },
    { to: '/krsps',    label: 'АС КРСПС',            icon: 'gate',  ready: true,  desc: 'Шлюз сообщений и таблица соответствий' },
];

// Крошки верхней планки: раздел и, при необходимости, шаг внутри него
export const CRUMBS: Record<string, string[]> = {
    '/': ['Главная'],
    '/cameras': ['Камеры'],
    '/live': ['Отображение', 'Редактор сеток'],
    '/archive': ['Архив'],
    '/devices': ['Устройства'],
};

// Крошки для путей с разделами внутри: /krsps/<модуль>, /surround/<подраздел>
export function crumbsFor(pathname: string): string[] {
    const exact = CRUMBS[pathname];
    if (exact) return exact;
    const krsps = /^\/krsps(?:\/([^/]+))?$/.exec(pathname);
    if (krsps) return krsps[1] ? ['АС КРСПС', sectionLabel(krsps[1], krsps[1])] : ['АС КРСПС'];
    const surround = /^\/surround(?:\/([^/]+))?$/.exec(pathname);
    if (surround) return surround[1] ? ['Система 360', surroundSectionLabel(surround[1])] : ['Система 360'];
    return ['Главная'];
}
