export function throttle<T extends (...args: any[]) => void>(
    fn: T,
    delay: number
): T {
    let lastCall = 0;
    return ((...args: any[]) => {
        const now = Date.now();
        if (now - lastCall >= delay) {
            lastCall = now;
            fn(...args);
        }
    }) as T;
}