import React from 'react';

// Локальный набор иконок страницы КРСПС: инлайновые SVG, currentColor —
// чтобы не тянуть внешнюю библиотеку и не зависеть от её стилей.

type IconProps = { className?: string };

const make = (path: string) => {
  const Icon: React.FC<IconProps> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
  return Icon;
};

export const IconSwap = make('M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z');
export const IconPlug = make(
  'M17 7V3h-2v4h-4V3H9v4H7v2h1v3a4 4 0 0 0 3 3.87V21h2v-4.13A4 4 0 0 0 16 12V9h1V7h-2zm-3 5a2 2 0 0 1-4 0V9h4v3z',
);
export const IconClock = make(
  'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2M12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8m.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
);
export const IconPin = make(
  'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7m0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5',
);
export const IconCheck = make('M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z');
export const IconClose = make('M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z');
export const IconHeart = make(
  'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3m-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05',
);
export const IconTune = make(
  'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
);
export const IconBack = make('M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z');
// Шина: разъём с расходящимися линиями — модуль CAN.
export const IconBus = make(
  'M4 4h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-5v2h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2v2h-2v-2H9v2H7v-2H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1h2v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m0 2v6h16V6zm5 10v2h2v-2zm4 0v2h2v-2z',
);
export const IconCheckCircle = make(
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z',
);
