import { createContext, useContext, useMemo } from 'react';
import { NAV, type NavItem } from './nav';
import { useSystem } from './SystemContext';

// Роль текущего пользователя: «admin» либо «viewer» (наблюдатель)
export const RoleContext = createContext<string>('viewer');
export const useRole = () => useContext(RoleContext);
export const isAdmin = (role: string) => role === 'admin';

// Разделы, доступные роли: у наблюдателя закрытые разделы и подразделы вырезаны
export function navFor(role: string): NavItem[] {
    if (isAdmin(role)) return NAV;
    return NAV
        .filter(item => !item.admin)
        .map(item => (item.sub ? { ...item, sub: item.sub.filter(s => !s.admin) } : item));
}

// Разделы роли без модулей, которых нет в системе. Модуль есть, если его несёт устройство
// (офлайн тоже: список модулей запоминается); шлюз КРСПС — служба сервера, хватает его ответа
export function useNav(role: string): NavItem[] {
    const { devices, gateway } = useSystem();
    return useMemo(() => navFor(role).filter(item => (
        !item.module
        || devices.some(d => d.modules.includes(item.module!))
        || (item.module === 'krsps' && gateway !== null)
    )), [role, devices, gateway]);
}

// Можно ли роли открыть адрес. Корень раздела с подразделами открыт всегда:
// экран сам перенаправит на первый доступный подраздел
export function canOpen(pathname: string, role: string): boolean {
    if (isAdmin(role)) return true;
    const item = NAV.find(i => i.to !== '/' && (pathname === i.to || pathname.startsWith(i.to + '/')));
    if (!item) return pathname === '/';
    if (item.admin) return false;
    if (!item.sub || pathname === item.to) return true;
    return item.sub.some(s => s.to === pathname && !s.admin);
}
