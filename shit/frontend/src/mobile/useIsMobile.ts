import { useEffect, useState } from 'react';

// Порог мобильной оболочки: планшет в портрете попадает, в ландшафте — нет
const QUERY = '(max-width: 900px)';

export function useIsMobile(): boolean {
    const [mobile, setMobile] = useState(() => window.matchMedia(QUERY).matches);

    useEffect(() => {
        const mq = window.matchMedia(QUERY);
        const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    return mobile;
}
