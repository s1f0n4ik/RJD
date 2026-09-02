import type { IconName } from './Icons';

/**
 * Разделы новой оболочки.
 *
 * ready:false — раздел ещё не переписан: пункт виден, приглушён и помечен
 * «в работе», клик по нему ничего не открывает. Так структура будущего
 * приложения видна целиком, а незаконченное не притворяется работающим.
 */
export interface NavItem {
    to: string;
    label: string;
    icon: IconName;
    ready: boolean;
    group?: string;
    /** Подпись на плитке главной, как в макете */
    desc?: string;
}

export const NAV: NavItem[] = [
    { to: '/',         label: 'Главная',             icon: 'home',  ready: true },
    { to: '/cameras',  label: 'Камеры',              icon: 'cam',   ready: true,  desc: 'Источники, потоки, разрешение' },
    { to: '/live',     label: 'Отображение',         icon: 'grid',  ready: true,  desc: 'Сетки просмотра и прямой эфир' },
    { to: '/archive',  label: 'Архив',               icon: 'arch',  ready: true,  desc: 'Записи, таймлайны и склейка' },
    { to: '/devices',  label: 'Устройства',          icon: 'dev',   ready: false },

    { to: '/neural',   label: 'Техническое зрение',  icon: 'eye',   ready: false, group: 'Модули' },
    { to: '/surround', label: 'Система 360',         icon: '360',   ready: false },
    { to: '/krsps',    label: 'АС КРСПС',            icon: 'gate',  ready: false },
];

// Крошки верхней планки: раздел и, при необходимости, шаг внутри него
export const CRUMBS: Record<string, string[]> = {
    '/': ['Главная'],
    '/cameras': ['Камеры'],
    '/live': ['Отображение', 'Редактор сеток'],
    '/archive': ['Архив'],
};
