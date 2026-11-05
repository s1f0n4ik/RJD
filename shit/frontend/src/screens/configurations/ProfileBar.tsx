import type { ReactNode } from 'react';
import { Icon } from '../../app/Icons';
import { Select } from '../../app/Select';
import { ActionMenu } from './ActionMenu';
import type { Profile } from './library-api';

const IMPORT = '__import__';

export const versionNumber = (profile: Profile) =>
    profile.versions.find((version) => version.id === profile.version_id)?.number ?? '?';

export const savedAt = (profile: Profile) => {
    const created = profile.versions.find((version) => version.id === profile.version_id)?.created;
    return created
        ? new Date(created * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '';
};

// Подсказка на недоступной кнопке: у отключённой кнопки событий мыши нет, поэтому подсказка на обёртке
function Gate({ tip, children }: { tip: string; children: ReactNode }) {
    return (
        <span className="lb-gate" data-tip={tip || undefined}>
            {children}
        </span>
    );
}

interface ProfileBarProps {
    profiles: Profile[];
    selected: string;
    // Причина, по которой менять нельзя; пусто — можно
    lock: string;
    // Меню «⋯» недоступно (нет связи или идёт загрузка профиля)
    menuLocked: boolean;
    switching: boolean;
    dirty: boolean;
    // Число отличий паспорта от профиля
    differences: number;
    onPick: (id: string) => void;
    onFold: () => void;
    onImport: () => void;
    onLoad: () => void;
    onUpdate: () => void;
    onExport: () => void;
    onVersions: () => void;
    onDelete: () => void;
}

export function ProfileBar(props: ProfileBarProps) {
    const { profiles, selected, lock, menuLocked, switching, dirty } = props;
    const profile = profiles.find((item) => item.id === selected);
    if (!profile) return null;
    const saveFirst = 'Сначала сохраните или сбросьте правки паспорта';
    const updateTip = lock || (!profile.active ? 'Паспорт обновляется у загруженного профиля' : dirty ? saveFirst : '');
    const loadTip = lock || (dirty ? saveFirst : '');
    const foldTip = lock || (dirty ? saveFirst : !props.differences ? 'Паспорт совпадает с профилем' : '');
    return (
        <div className="lb-pbar">
            <Select
                className="lb-switch"
                popClassName="lb-pop"
                value={selected}
                disabled={switching}
                options={[
                    ...profiles.map((item) => ({
                        value: item.id,
                        label: item.name,
                        hint: `v${versionNumber(item)} · ${item.active ? 'активный' : 'не загружен'}`,
                        dot: item.active ? ('ok' as const) : undefined,
                    })),
                    { value: IMPORT, label: 'Импорт из файла', hint: lock, disabled: !!lock },
                ]}
                display={
                    <span className="lb-switch-nm">
                        <b>{profile.name}</b>
                        <span>
                            {profile.id} · v{versionNumber(profile)}
                        </span>
                    </span>
                }
                onChange={(value) => (value === IMPORT ? props.onImport() : props.onPick(value))}
            />
            <div className="lb-meta">
                <span className="lb-tags">
                    <span className={`tag${profile.active ? ' is-ok' : ''}`}>
                        <i className={`dot${profile.active ? ' ok' : ''}`} />
                        {profile.active ? 'Активный профиль' : 'Не загружен'}
                    </span>
                    <span className="tag num">v{versionNumber(profile)}</span>
                    <span className="tag" data-tip="Профиль только для чтения: машинные отличия хранятся в паспорте">
                        <Icon name="lock" size={12} />
                        Только чтение
                    </span>
                </span>
                <span className="lb-saved">Сохранён {savedAt(profile)}</span>
            </div>
            <div className="lb-actions">
                {!profile.active && (
                    <Gate tip={loadTip}>
                        <button className="btn btn--acc" disabled={!!loadTip} onClick={props.onLoad}>
                            Загрузить профиль
                        </button>
                    </Gate>
                )}
                <Gate tip={updateTip}>
                    <button className="btn btn--acc-dim" disabled={!!updateTip} onClick={props.onUpdate}>
                        <Icon name="swap" size={16} />
                        Обновить паспорт
                    </button>
                </Gate>
                <ActionMenu
                    label="Ещё"
                    disabled={menuLocked}
                    items={[
                        { label: 'Экспорт профиля', icon: 'up', onSelect: props.onExport },
                        { label: 'Версии профиля', icon: 'list', onSelect: props.onVersions },
                        {
                            label: 'Заменить паспорт по умолчанию',
                            icon: 'layers',
                            hint: foldTip,
                            disabled: !!foldTip,
                            onSelect: props.onFold,
                        },
                        null,
                        {
                            label: 'Удалить профиль',
                            icon: 'trash',
                            danger: true,
                            hint: profile.active ? 'Активный профиль удалить нельзя' : lock,
                            disabled: profile.active || !!lock,
                            onSelect: props.onDelete,
                        },
                    ]}
                />
            </div>
        </div>
    );
}
