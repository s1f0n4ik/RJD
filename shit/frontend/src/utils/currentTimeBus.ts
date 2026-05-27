// Шина для передачи currentTime между плеером и timeline,
// минуя React state родителя. Это убирает ре-рендер RecordingsView
// на каждом тике видео (~4 раза в секунду).

type Listener = (minutes: number | undefined) => void;

const listeners = new Set<Listener>();
let lastValue: number | undefined = undefined;

export const currentTimeBus = {
    set(minutes: number | undefined) {
        lastValue = minutes;
        listeners.forEach(fn => fn(minutes));
    },
    get(): number | undefined {
        return lastValue;
    },
    subscribe(fn: Listener): () => void {
        listeners.add(fn);
        return () => {
            listeners.delete(fn);
        };
    },
};