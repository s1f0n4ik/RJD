import type { IconName } from './Icons';
import { sectionLabel } from '../screens/krsps/sections';
import { SURROUND_SECTIONS, surroundSectionLabel } from '../screens/surround/sections';
import { NEURAL_SECTIONS, neuralSectionLabel } from '../screens/neural/sections';

/**
 * Разделы оболочки.
 *
 * admin:true — раздел (или подраздел) только для администратора: наблюдатель
 * его не видит ни в рельсе, ни на главной, а прямой адрес уводит на главную.
 * Фильтрация — в role.ts.
 */
export interface NavSubItem {
    to: string;
    label: string;
    /** Номер шага: подразделы — реальная последовательность настройки */
    n: string;
    admin?: boolean;
}

export interface NavItem {
    to: string;
    label: string;
    icon: IconName;
    admin?: boolean;
    group?: string;
    /** Подпись на плитке главной, как в макете */
    desc?: string;
    /** Подсписок в рельсе, виден только в активном разделе */
    sub?: NavSubItem[];
}

// Подразделы техзрения: наблюдателю открыт только журнал обнаружений
const NEURAL_VIEWER_SECTIONS = new Set(['journal']);

export const NAV: NavItem[] = [
    { to: '/',         label: 'Главная',             icon: 'home' },
    { to: '/cameras',  label: 'Камеры',              icon: 'cam',   desc: 'Источники, потоки, разрешение' },
    { to: '/live',     label: 'Отображение',         icon: 'grid',  desc: 'Сетки просмотра и прямой эфир', admin: true },
    { to: '/archive',  label: 'Архив',               icon: 'arch',  desc: 'Записи, таймлайны и склейка' },
    { to: '/devices',  label: 'Устройства',          icon: 'dev',   desc: 'Одноплатники: состояние и маршрутизация', admin: true },

    {
        to: '/neural', label: 'Техническое зрение', icon: 'eye', group: 'Модули', desc: 'Конфигурации, потоки, журнал обнаружений',
        sub: NEURAL_SECTIONS.map((s, i) => ({
            to: `/neural/${s.id}`, label: s.label, n: String(i + 1).padStart(2, '0'), admin: !NEURAL_VIEWER_SECTIONS.has(s.id),
        })),
    },
    {
        to: '/surround', label: 'Система 360', icon: '360', desc: 'Калибровка, сборка, конфигуратор', admin: true,
        sub: SURROUND_SECTIONS.map((s, i) => ({ to: `/surround/${s.id}`, label: s.label, n: String(i + 1).padStart(2, '0') })),
    },
    { to: '/krsps',    label: 'АС КРСПС',            icon: 'gate',  desc: 'Шлюз сообщений и таблица соответствий', admin: true },
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
    const neural = /^\/neural(?:\/([^/]+))?$/.exec(pathname);
    if (neural) return neural[1] ? ['Техническое зрение', neuralSectionLabel(neural[1])] : ['Техническое зрение'];
    return ['Главная'];
}
