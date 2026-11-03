import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';

export function useNavigationGuard(dirty: boolean, guard: (action: () => void) => void, keepDraft?: (path: string) => boolean) {
    const unloadApproved = useRef(false);
    const exitApproved = useRef(false);
    const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !keepDraft?.(nextLocation.pathname)
        && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search || currentLocation.hash !== nextLocation.hash));
    const leave = useCallback((url: string) => {
        unloadApproved.current = true;
        window.location.assign(url);
    }, []);

    useEffect(() => {
        if (blocker.state === 'blocked') guard(blocker.proceed);
    }, [blocker, guard]);

    useEffect(() => {
        const onUnload = (event: BeforeUnloadEvent) => {
            if (!dirty || unloadApproved.current) return;
            event.preventDefault();
            event.returnValue = '';
        };
        const onClick = (event: MouseEvent) => {
            if (!dirty || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const exit = (event.target as Element | null)?.closest('[data-exit-app]');
            if (exit instanceof HTMLButtonElement) {
                if (exitApproved.current) return;
                event.preventDefault();
                event.stopPropagation();
                guard(() => {
                    exitApproved.current = true;
                    try { exit.click(); } finally { exitApproved.current = false; }
                });
                return;
            }
            const link = (event.target as Element | null)?.closest('a[href]');
            if (!(link instanceof HTMLAnchorElement) || link.download || (link.target && link.target !== '_self')) return;
            const url = new URL(link.href);
            if (url.href === window.location.href || (url.origin === window.location.origin && /^\/app(?:\/|$)/.test(url.pathname))) return;
            event.preventDefault();
            event.stopPropagation();
            guard(() => leave(url.href));
        };
        window.addEventListener('beforeunload', onUnload);
        document.addEventListener('click', onClick, true);
        return () => {
            window.removeEventListener('beforeunload', onUnload);
            document.removeEventListener('click', onClick, true);
        };
    }, [dirty, guard, leave]);
    return { leave, cancelNavigation: () => { if (blocker.state === 'blocked') blocker.reset(); } };
}
