import { useEffect, useRef } from 'react';
import { Icon } from '../../app/Icons';
import { isModalOpen } from '../../app/Modal';
import { PROFILE_SECTIONS, type BrokenItem } from './profile-model';

// Шторка справа: ошибки ссылок по разделам профиля
export function ErrorsDrawer({
    items,
    current,
    onClose,
    onShow,
    onOpenModule,
}: {
    items: BrokenItem[];
    current: number;
    onClose: () => void;
    onShow: (index: number) => void;
    onOpenModule: (to: string) => void;
}) {
    const closeButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        closeButton.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !isModalOpen()) onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <>
            <div className="lb-scrim" onMouseDown={onClose} />
            <aside className="lb-drawer" role="dialog" aria-label="Ошибки ссылок">
                <div className="lb-drawer-h">
                    <h3>Ошибки ссылок</h3>
                    <span className="lb-n">{items.length}</span>
                    <button ref={closeButton} className="x" onClick={onClose} aria-label="Закрыть">
                        <Icon name="x" size={16} />
                    </button>
                </div>
                <div className="lb-drawer-b">
                    {PROFILE_SECTIONS.filter((section) => items.some((item) => item.section === section.id)).map((section) => (
                        <div key={section.id}>
                            <div className="lb-dg-h">
                                {section.name}
                                <span className="lb-n">{items.filter((item) => item.section === section.id).length}</span>
                            </div>
                            {items.map((item, index) =>
                                item.section !== section.id ? null : (
                                    <div className={`lb-er${current === index ? ' is-cur' : ''}`} key={index}>
                                        <div className="t">
                                            <b>{item.title}</b>
                                            <span className="lb-id">{item.id}</span>
                                        </div>
                                        <span className="f">{item.field}</span>
                                        <span className="miss">
                                            <Icon name="warn" size={14} />
                                            Не найдено <code>{item.miss}</code>
                                        </span>
                                        <div className="acts">
                                            <button className="btn btn--sm btn--acc-dim" onClick={() => onShow(index)}>
                                                Показать в профиле
                                            </button>
                                            {item.module && (
                                                <button className="btn btn--sm btn--ghost" onClick={() => onOpenModule(item.module!.to)}>
                                                    <Icon name="jump" size={14} />
                                                    Открыть: {item.module.label}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ),
                            )}
                        </div>
                    ))}
                </div>
                <div className="lb-drawer-f">
                    <span className="sp">Ссылка исправляется там, где её создали</span>
                    <button className="btn" onClick={onClose}>
                        Закрыть
                    </button>
                </div>
            </aside>
        </>
    );
}
