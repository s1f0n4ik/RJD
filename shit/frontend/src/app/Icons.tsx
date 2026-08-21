// Спрайт иконок макета: один набор на всё приложение, толщина линии единая
export type IconName = 'home' | 'grid' | 'arch' | 'cam' | 'eye' | '360' | 'gate' | 'menu' | 'cursor' | 'zone' | 'img' | 'gab' | 'cal' | 'play' | 'pause' | 'prev' | 'next' | 'swap' | 'bus' | 'clock' | 'tune' | 'chev' | 'dev' | 'kit' | 'plus' | 'search' | 'exit' | 'warn' | 'box' | 'map' | 'full' | 'trash' | 'save' | 'x' | 'empty' | 'lock';

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
    <symbol id="i-home" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></symbol>
    <symbol id="i-grid" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/></symbol>
    <symbol id="i-arch" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/></symbol>
    <symbol id="i-cam" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="11" height="10" rx="1"/><path d="M14 10.5 21 7v10l-7-3.5z"/></symbol>
    <symbol id="i-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></symbol>
    <symbol id="i-360" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="12" rx="9.5" ry="5"/><path d="M12 3.2a9 9 0 0 1 0 17.6M12 3.2a9 9 0 0 0 0 17.6"/></symbol>
    <symbol id="i-gate" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3v5M17 3v5M5 8h14v4a7 7 0 0 1-14 0zM12 19v2"/></symbol>
    <symbol id="i-menu" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
    <symbol id="i-cursor" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M5 3l14 8-6 1.6L9.6 19z"/></symbol>
    <symbol id="i-zone" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3.5 3"/></symbol>
    <symbol id="i-img" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/></symbol>
    <symbol id="i-gab" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="3" y="7" width="18" height="10" rx="1"/><path d="M3 4v3M21 4v3M3 17v3M21 17v3"/></symbol>
    <symbol id="i-cal" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></symbol>
    <symbol id="i-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></symbol>
    <symbol id="i-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5h3.4v14H8zM12.6 5H16v14h-3.4z"/></symbol>
    <symbol id="i-prev" viewBox="0 0 24 24" fill="currentColor"><path d="M17 5.5v13L8 12zM7 5.5h1.8v13H7z"/></symbol>
    <symbol id="i-next" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5v13L16 12zM15.2 5.5H17v13h-1.8z"/></symbol>
    <symbol id="i-swap" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/></symbol>
    <symbol id="i-bus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18M7 12V6M12 12v8M17 12V6"/><circle cx="7" cy="4.5" r="1.5"/><circle cx="17" cy="4.5" r="1.5"/><circle cx="12" cy="21" r="1.5"/></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/></symbol>
    <symbol id="i-tune" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></symbol>
    <symbol id="i-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m9 5 7 7-7 7"/></symbol>
    <symbol id="i-dev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></symbol>
    <symbol id="i-kit" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><circle cx="8" cy="8" r="4.4"/><rect x="13" y="13" width="8" height="8" rx="1.6"/><path d="M13 4h8v6h-8z"/></symbol>
    <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></symbol>
    <symbol id="i-exit" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-4 4 4 4M6 12h9"/></symbol>
    <symbol id="i-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4 2.6 20h18.8z"/><path d="M12 10v4.4M12 17.4v.2"/></symbol>
    <symbol id="i-box" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 3 3.5 7.6v8.8L12 21l8.5-4.6V7.6z"/><path d="M3.5 7.6 12 12.2l8.5-4.6M12 12.2V21"/></symbol>
    <symbol id="i-map" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></symbol>
    <symbol id="i-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/></symbol>
    <symbol id="i-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4.6h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></symbol>
    <symbol id="i-save" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M4 5a1 1 0 0 1 1-1h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M8 4h7v5H8zM7 20v-6h10v6"/></symbol>
    <symbol id="i-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18"/></symbol>
    <symbol id="i-empty" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" strokeDasharray="4 3.4"/><path d="M8.6 12h6.8"/></symbol>
    <symbol id="i-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7.4a4 4 0 0 1 8 0V10"/></symbol>
      </defs>
    </svg>
  );
}

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 18, className = 'ico' }: IconProps) {
  return (
    <svg className={className} width={size} height={size} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
