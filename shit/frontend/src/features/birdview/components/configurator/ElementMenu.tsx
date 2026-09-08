import { useEffect } from 'react';
import { pointAnchor, usePopover } from '../../../../app/popover';
import { confState, fmtM, useConfStore } from '../../state/conf-store';
import { confCenterGabarit, confDelete, confRenameCamera } from './conf-actions';
import type { ConfItemType } from '../../types';

// Меню элемента по правой кнопке: открывается в точке клика поверх холста

interface ElementMenuProps {
    type: ConfItemType;
    id: string;
    x: number;
    y: number;
    onClose: () => void;
}

const TITLE: Record<ConfItemType, string> = {
    camera: 'Камера',
    zone: 'Разметка',
    image: 'Рисунок',
    gabarit: 'Габарит',
};

export function ElementMenu({ type, id, x, y, onClose }: ElementMenuProps) {
    useConfStore();
    const ref = usePopover<HTMLDivElement>(pointAnchor(x, y), { side: 'bottom', align: 'start' });

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) onClose();
        };

        // Открывшее меню событие ещё всплывает: слушатели ставятся кадром позже,
        // иначе тот же contextmenu тут же закрывает только что открытое меню
        const armed = requestAnimationFrame(() => {
            document.addEventListener('mousedown', onDown);
            document.addEventListener('contextmenu', onDown);
        });
        window.addEventListener('keydown', onKey);

        return () => {
            cancelAnimationFrame(armed);
            window.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('contextmenu', onDown);
        };
    }, [onClose, ref]);

    const cam = type === 'camera' ? confState.cameras.find(c => c.id === id) : undefined;
    const zone = type === 'zone' ? confState.zones.find(z => z.id === id) : undefined;
    const img = type === 'image' ? confState.images.find(i => i.id === id) : undefined;
    const gab = type === 'gabarit' ? confState.gabarits.find(g => g.id === id) : undefined;

    if (!cam && !zone && !img && !gab) return null;

    return (
        <div ref={ref} className="conf-menu" style={{ visibility: 'hidden' }}>
            <div className="conf-menu-h">
                <span className="eyebrow">{TITLE[type]}</span>
                <span className="num spacer">
                    {cam && `${fmtM(cam.w)} × ${fmtM(cam.h)} м`}
                    {zone && `${fmtM(zone.w)} м`}
                    {img && `${fmtM(img.w)} × ${fmtM(img.h)} м`}
                    {gab && `${fmtM(gab.h)} × ${fmtM(gab.w)} м`}
                </span>
            </div>

            {cam && (
                <input
                    className="tf-in"
                    type="text"
                    autoFocus
                    value={cam.name}
                    onChange={e => confRenameCamera(cam.id, { name: e.target.value })}
                    onBlur={e => confRenameCamera(cam.id, { name: e.target.value.trim() })}
                    onKeyDown={e => {
                        if (e.key === 'Enter') onClose();
                    }}
                />
            )}
            {cam && <div className="kv"><span className="k">Ключ</span><span className="v">{cam.key}</span></div>}
            {zone && <div className="kv"><span className="k">Имя</span><span className="v">{zone.name}</span></div>}
            {img && <div className="kv"><span className="k">Файл</span><span className="v">{img.name}</span></div>}

            <div className="conf-menu-acts">
                {gab && (
                    <button
                        type="button"
                        className="btn btn--sm btn--wide"
                        onClick={() => {
                            confCenterGabarit();
                            onClose();
                        }}
                    >
                        Оцентровать
                    </button>
                )}
                <button
                    type="button"
                    className="btn btn--sm btn--err btn--wide"
                    onClick={() => {
                        confDelete(type, id);
                        onClose();
                    }}
                >
                    Удалить
                </button>
            </div>
        </div>
    );
}
