import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { EASE_IN, EASE_OUT, reducedMotion } from '../../app/motion';
import { Select } from '../../app/Select';
import type { ClassDef, NeuralConfig } from '../../features/neural/api/types';
import { ColorPicker } from './ColorPicker';

// Палитра: статусы и акцент приложения
const PALETTE = ['#f66773', '#ee9b58', '#edbc51', '#53cf95', '#4dc4ee', '#68a5ff', '#9f93f5', '#e7e9ee'];
// Сколько держится взведённое удаление
const ARM_MS = 3000;

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Сдвиг и масштаб, переводящие рамку окна в рамку чипа
const toRect = (from: DOMRect, to: DOMRect) =>
    `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) `
    + `scale(${to.width / from.width}, ${to.height / from.height})`;

interface ClassModalProps {
    id: string;
    value: NeuralConfig;
    // Чип, из которого окно вырастает и в который уходит при закрытии
    origin: HTMLElement | null;
    onApply: (next: ClassDef) => void;
    onRemove: () => void;
    onClose: () => void;
}

// Правка класса: название, server_id, суперкласс, цвет; «Применить» кладёт правку в черновик конфигурации
export function ClassModal({ id, value, origin, onApply, onRemove, onClose }: ClassModalProps) {
    const saved = value.classes[id];
    const [draft, setDraft] = useState<ClassDef>(saved);
    const [armed, setArmed] = useState(false);
    const [own, setOwn] = useState<HTMLButtonElement | null>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const leaving = useRef(false);

    const supers = value.superclasses;
    const superKey = supers[draft.superclass] ? draft.superclass : '';
    const superColor = superKey ? supers[superKey].color : undefined;
    const changed = (Object.keys(saved) as (keyof ClassDef)[]).some(k => draft[k] !== saved[k]);
    const custom = !PALETTE.some(c => same(c, draft.color)) && !same(superColor, draft.color);

    const patch = (p: Partial<ClassDef>) => setDraft(d => ({ ...d, ...p }));

    // Окно вырастает из чипа, содержимое проявляется следом
    useLayoutEffect(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
        const modal = bodyRef.current?.closest<HTMLElement>('.modal');
        if (!modal || !origin || reducedMotion()) return;
        modal.animate(
            [{ transform: toRect(modal.getBoundingClientRect(), origin.getBoundingClientRect()), opacity: 0.2 }, { transform: 'none', opacity: 1 }],
            { duration: 280, easing: EASE_OUT },
        );
        for (const part of Array.from(modal.children)) {
            part.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: 300 });
        }
    }, [origin]);

    // Уход: в чип, если он на месте, иначе проседанием; done — после анимации
    const leave = useCallback((done: () => void, intoChip: boolean) => {
        if (leaving.current) return;
        leaving.current = true;
        const modal = bodyRef.current?.closest<HTMLElement>('.modal');
        const overlay = modal?.parentElement;
        if (!modal || !overlay || reducedMotion()) {
            done();
            return;
        }
        const target = intoChip && origin?.isConnected ? origin.getBoundingClientRect() : null;
        const end = target ? toRect(modal.getBoundingClientRect(), target) : 'translateY(6px) scale(.98)';
        overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: EASE_IN, fill: 'forwards' });
        modal.animate([{ transform: 'none', opacity: 1 }, { transform: end, opacity: 0 }], { duration: target ? 200 : 150, easing: EASE_IN, fill: 'forwards' })
            .onfinish = done;
    }, [origin]);

    const close = useCallback(() => leave(onClose, true), [leave, onClose]);
    const apply = () => {
        if (changed) leave(() => onApply(draft), false);
    };
    const remove = () => {
        if (armed) leave(onRemove, false);
        else setArmed(true);
    };

    useEffect(() => {
        if (!armed) return;
        const timer = window.setTimeout(() => setArmed(false), ARM_MS);
        return () => window.clearTimeout(timer);
    }, [armed]);

    const groupOf = (c: ClassDef) => (supers[c.superclass] ? c.superclass : '');
    const options = [...Object.keys(supers), ''].map(key => ({
        value: key,
        label: key ? supers[key].name || key : 'Без суперкласса',
        hint: `${Object.values(value.classes).filter(c => groupOf(c) === key).length} кл.`,
        color: key ? supers[key].color : undefined,
    }));
    // Как при перетаскивании: класс берёт цвет нового суперкласса
    const setSuper = (key: string) => patch(key ? { superclass: key, color: supers[key].color } : { superclass: '' });

    return (
        <Modal
            title={draft.name || 'Без названия'}
            className="cls-modal"
            onClose={close}
            head={(
                <>
                    <span className="cm-sw" style={{ background: draft.color }} />
                    <span className="cm-id">id {id}</span>
                </>
            )}
            footer={(
                <>
                    <button className={`btn btn--ghost cm-del${armed ? ' is-arm' : ''}`} onClick={remove}>
                        <Icon name="trash" size={14} />
                        {armed ? `Удалить класс ${id}?` : 'Удалить'}
                    </button>
                    <button className="btn spacer" onClick={close}>Отмена</button>
                    <button className="btn btn--acc" disabled={!changed} onClick={apply}>Применить</button>
                </>
            )}
        >
            <div
                ref={bodyRef}
                className="modal-b cm-body"
                onKeyDown={e => {
                    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
                    e.preventDefault();
                    apply();
                }}
            >
                <div className="tf">
                    <span className="tf-cap">Название</span>
                    <input ref={nameRef} className="tf-in" value={draft.name} placeholder="Название" onChange={e => patch({ name: e.target.value })} />
                </div>
                <div className="tf-row">
                    <div className="tf">
                        <span className="tf-cap">server_id</span>
                        <input className="tf-in" value={draft.server_id} placeholder="server_id" onChange={e => patch({ server_id: e.target.value })} />
                    </div>
                    <div className="tf cm-n">
                        <span className="tf-cap">id</span>
                        <input className="tf-in is-ro" value={id} readOnly />
                    </div>
                </div>
                <div className="tf">
                    <span className="tf-cap">Суперкласс</span>
                    <Select value={superKey} options={options} onChange={setSuper} />
                </div>
                <div className="tf">
                    <span className="tf-cap">Цвет</span>
                    <div className="cm-pal">
                        {superColor && (
                            <>
                                <button
                                    type="button"
                                    className={`cm-sup${same(superColor, draft.color) ? ' is-on' : ''}`}
                                    style={{ '--c': superColor } as React.CSSProperties}
                                    data-tip={`Цвет суперкласса «${supers[superKey].name || superKey}»`}
                                    onClick={() => patch({ color: superColor })}
                                >
                                    <Icon name="link" size={13} />
                                </button>
                                <span className="cm-sep" />
                            </>
                        )}
                        {PALETTE.map(c => (
                            <button
                                key={c}
                                type="button"
                                className={same(c, draft.color) && !same(c, superColor) ? 'is-on' : undefined}
                                style={{ '--c': c } as React.CSSProperties}
                                aria-label={c}
                                onClick={() => patch({ color: c })}
                            />
                        ))}
                        <button
                            type="button"
                            className={`cm-own${custom ? ' is-set is-on' : ''}${own ? ' is-open' : ''}`}
                            style={{ '--c': draft.color } as React.CSSProperties}
                            data-tip="Свой цвет"
                            onClick={e => setOwn(own ? null : e.currentTarget)}
                        >
                            <Icon name={custom ? 'pen' : 'plus'} size={12} />
                        </button>
                    </div>
                    {own && <ColorPicker anchor={own} color={draft.color} onChange={color => patch({ color })} onClose={() => setOwn(null)} />}
                </div>
            </div>
        </Modal>
    );
}
