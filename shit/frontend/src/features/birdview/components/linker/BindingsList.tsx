import { PROJ_POSITION_LABELS } from '../../constants';
import { CustomSelect } from '../common/CustomSelect';
import type { LinkerBindings, LinkerCamera } from '../../api/linker';

/** Привязка «позиция → камера». Порт renderBindings. */

interface BindingsListProps {
    /** Ключи позиций из выбранной конфигурации. */
    keys: string[];
    cameras: LinkerCamera[];
    bindings: LinkerBindings;
    onChange: (key: string, cameraId: string | null) => void;
}

const UNBOUND = '';

export function BindingsList({ keys, cameras, bindings, onChange }: BindingsListProps) {
    const options = [
        { value: UNBOUND, label: '— не привязана —' },
        ...cameras.map(c => ({ value: c.id, label: `${c.display_name} [${c.id}]` })),
    ];

    return (
        <div className="linker-list">
            {keys.map(key => {
                const currentId = bindings[key] ?? null;
                return (
                    <div
                        key={key}
                        className={`linker-list-item${currentId ? ' selected' : ''}`}
                        style={{ cursor: 'default' }}
                    >
                        <div className="linker-list-main">
                            <span className="linker-list-name">
                                {PROJ_POSITION_LABELS[key] ?? key}
                            </span>
                            <span className="linker-list-id">{key}</span>
                        </div>

                        <div className="linker-binding-control">
                            <CustomSelect
                                options={options}
                                value={currentId ?? UNBOUND}
                                placeholder="— не привязана —"
                                emptyText="Нет камер type=3"
                                onChange={v => onChange(key, v === UNBOUND ? null : v)}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
