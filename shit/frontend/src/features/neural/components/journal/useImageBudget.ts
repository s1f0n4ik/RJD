import { useCallback, useRef, useState } from 'react';

// Своего кеша изображений у журнала нет — картинки грузит браузер по обычному
// <img src>. Ограничивать надо не браузерный HTTP-кеш (его размером управляет
// сам браузер), а количество ОДНОВРЕМЕННО смонтированных изображений: список
// держит сотни записей, и после прокрутки все их картинки остались бы в памяти
// декодированными. Здесь — LRU-бюджет: живыми остаются последние N показанных,
// остальные размонтируются и подгрузятся заново, когда снова попадут на экран.
export function useImageBudget(max: number) {
  const [allowed, setAllowed] = useState<Set<number>>(() => new Set());
  // Порядок обращений: в конце — самые недавно показанные.
  const order = useRef<number[]>([]);

  const request = useCallback(
    (id: number) => {
      setAllowed((prev) => {
        if (prev.has(id)) {
          // Уже смонтирована — просто освежаем позицию в LRU. Множество не
          // меняется, поэтому возвращаем прежнее и лишнего рендера не будет.
          const i = order.current.indexOf(id);
          if (i >= 0) {
            order.current.splice(i, 1);
            order.current.push(id);
          }
          return prev;
        }

        const next = new Set(prev);
        next.add(id);
        order.current.push(id);
        while (order.current.length > max) {
          const evicted = order.current.shift();
          if (evicted != null) next.delete(evicted);
        }
        return next;
      });
    },
    [max],
  );

  return { allowed, request };
}
