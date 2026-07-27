import { useRef } from 'react';
import type React from 'react';

/**
 * Закрытие модалки кликом по подложке — без ложных срабатываний.
 *
 * Голый onClick на подложке закрывал окно при выделении текста в поле:
 * браузер назначает целью click общего предка mousedown и mouseup, и
 * протяжка из инпута на подложку считалась кликом по ней. Закрываемся,
 * только когда нажатие и отпускание случились на самой подложке.
 */
export function useBackdropClose(onClose: () => void) {
    const downOnSelf = useRef(false);

    return {
        onMouseDown: (e: React.MouseEvent) => {
            downOnSelf.current = e.target === e.currentTarget;
        },
        onClick: (e: React.MouseEvent) => {
            if (downOnSelf.current && e.target === e.currentTarget) onClose();
            downOnSelf.current = false;
        },
    };
}
