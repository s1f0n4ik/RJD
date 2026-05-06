import { useEffect, useState } from 'react';

/**
 * Возвращает true, если основное устройство ввода — сенсорное
 * (палец/стилус, без мыши).
 *
 * Используем pointer: coarse — самый надёжный признак тач-экрана
 * во всех современных браузерах.
 */
export const useTouchDevice = (): boolean => {
  const [isTouch, setIsTouch] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(pointer: coarse)').matches;
  });

  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const handler = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isTouch;
};