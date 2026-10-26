import { useEffect, useState } from 'react';

// Порог мобильной оболочки: планшет в портрете попадает, в ландшафте — нет
const QUERY = '(max-width: 900px)';

// Телефон в любом положении: в ландшафте широкий телефон шире порога оболочки
export const PHONE_QUERY = `${QUERY}, (orientation: landscape) and (max-height: 520px) and (pointer: coarse)`;

export function useIsMobile(query: string = QUERY): boolean {
    const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);

    useEffect(() => {
        const mq = window.matchMedia(query);
        setMobile(mq.matches);
        const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [query]);

    return mobile;
}
