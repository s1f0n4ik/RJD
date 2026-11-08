import { useMemo, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Select } from '../../app/Select';
import { getDevices } from '../../services/devices';
import type { StreamPurpose } from '../../types';
import {
    PRODUCTION_NAMES,
    PURPOSE_MODULE,
    PURPOSE_NAMES,
    PURPOSE_ORDER,
    purposeAvailable,
    type CameraFormData,
    type Validation,
} from './model';

export interface FieldsProps {
    form: CameraFormData;
    onChange: (patch: Partial<CameraFormData>) => void;
}

/** Модули устройства-владельца. */
export function useDeviceModules(deviceId: string): string[] {
    const devices = getDevices();
    const key = devices.map(d => d.id + d.modules.join()).join();
    return useMemo(
        () => devices.find(d => d.id === deviceId)?.modules ?? [],
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key, deviceId],
    );
}

/** Поле с подписью сверху. */
export function Cell({ cap, children }: { cap: string; children: React.ReactNode }) {
    return (
        <label className="fcell">
            <span className="fcap">{cap}</span>
            {children}
        </label>
    );
}

export function NumCell({ cap, value, onValue }: { cap: string; value: number; onValue: (n: number) => void }) {
    return (
        <Cell cap={cap}>
            <input
                className="inp inp--num"
                type="number"
                value={value}
                onChange={e => {
                    const n = parseInt(e.target.value, 10);
                    onValue(Number.isNaN(n) ? 0 : n);
                }}
            />
        </Cell>
    );
}

function PasswordCell({ value, placeholder, onValue }: {
    value: string;
    placeholder?: string;
    onValue: (v: string) => void;
}) {
    const [shown, setShown] = useState(false);
    return (
        <div className="fcell">
            <span className="fcap">Пароль</span>
            <span className="pwd">
                <input
                    className="inp"
                    type={shown ? 'text' : 'password'}
                    value={value}
                    placeholder={placeholder}
                    onChange={e => onValue(e.target.value)}
                />
                <button
                    type="button"
                    className="eye"
                    onClick={() => setShown(v => !v)}
                    data-tip={shown ? 'Скрыть пароль' : 'Показать пароль'}
                    aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
                >
                    <Icon name="eye" size={14} />
                </button>
            </span>
        </div>
    );
}

interface ConnectionFieldsProps extends FieldsProps {
    editMode: boolean;
    autoName: string;
    nameCheck: Validation;
    ipCheck: Validation;
    portCheck: Validation;
    /** Имя камеры и отображаемое имя; в панели правки id заблокирован, отображаемое имя правится */
    withName?: boolean;
}

export function ConnectionFields({
    form, onChange, editMode, autoName, nameCheck, ipCheck, portCheck, withName = false,
}: ConnectionFieldsProps) {
    const devices = getDevices();

    return (
        <div className="fields">
            {withName && (
                <>
                    <div className="frow">
                        <Cell cap="Имя камеры">
                            <input
                                className={`inp${nameCheck.valid ? '' : ' is-err'}`}
                                style={{ fontFamily: 'var(--mono)' }}
                                value={form.id}
                                placeholder={autoName}
                                disabled={editMode}
                                onChange={e => onChange({ id: e.target.value })}
                            />
                        </Cell>
                        <Cell cap="Отображаемое имя">
                            <input
                                className="inp"
                                value={form.display_name}
                                placeholder={form.id || autoName}
                                onChange={e => onChange({ display_name: e.target.value })}
                            />
                        </Cell>
                    </div>
                    {!nameCheck.valid && <p className="hint is-err" style={{ margin: 0 }}>{nameCheck.error}</p>}
                </>
            )}

            <div className="frow">
                <Cell cap="IP-адрес камеры">
                    <input
                        className={`inp${ipCheck.valid ? '' : ' is-err'}`}
                        value={form.ip_adress}
                        placeholder="192.168.1.36"
                        onChange={e => onChange({ ip_adress: e.target.value.trim() })}
                    />
                </Cell>
                <Cell cap="Порт RTSP">
                    <input
                        className={`inp inp--num${portCheck.valid ? '' : ' is-err'}`}
                        value={form.port}
                        onChange={e => onChange({ port: e.target.value.trim() })}
                    />
                </Cell>
            </div>
            {!ipCheck.valid && form.ip_adress !== '' && (
                <p className="hint is-err" style={{ margin: 0 }}>{ipCheck.error}</p>
            )}
            {!portCheck.valid && <p className="hint is-err" style={{ margin: 0 }}>{portCheck.error}</p>}

            <div className="frow">
                <Cell cap="Логин камеры">
                    <input
                        className="inp"
                        value={form.user}
                        onChange={e => onChange({ user: e.target.value })}
                    />
                </Cell>
                <PasswordCell
                    value={form.password}
                    placeholder={editMode ? 'без изменений' : undefined}
                    onValue={v => onChange({ password: v })}
                />
            </div>

            <div className="frow">
                <Cell cap="Производитель">
                    <Select
                        value={String(form.production)}
                        onChange={v => onChange({ production: Number(v) })}
                        options={Object.entries(PRODUCTION_NAMES).map(([value, name]) => ({ value, label: name }))}
                    />
                </Cell>
                <Cell cap="Устройство">
                    <Select
                        value={form.device_id}
                        onChange={v => onChange({ device_id: v })}
                        options={devices.map(d => ({
                            value: d.id,
                            label: d.name || d.id,
                            disabled: d.status !== 'online',
                            hint: d.status === 'online' ? d.modules.join(', ') || 'без модулей' : 'не в сети',
                        }))}
                    />
                </Cell>
            </div>
            {withName && (
                <Cell cap="Описание">
                    <textarea
                        className="inp cd-area"
                        value={form.description}
                        onChange={e => onChange({ description: e.target.value })}
                    />
                </Cell>
            )}

            {devices.length === 0 && (
                <p className="hint is-err" style={{ margin: 0 }}>
                    В системе нет устройств — добавьте устройство, прежде чем заводить камеры
                </p>
            )}
        </div>
    );
}

interface PurposePickerProps {
    purposes: StreamPurpose[];
    modules: string[];
    /** Уменьшенный набор — для карточки потока в мастере */
    compact?: boolean;
    onToggle: (purpose: StreamPurpose) => void;
}

/** Назначения потока; недоступные выключены. */
export function PurposePicker({ purposes, modules, compact, onToggle }: PurposePickerProps) {
    return (
        <div className="purp-pick">
            {PURPOSE_ORDER.map(purpose => {
                const available = purposeAvailable(purpose, modules);
                const on = purposes.includes(purpose);
                return (
                    <button
                        key={purpose}
                        type="button"
                        className={`purp-btn${compact ? ' purp-btn--sm' : ''} purp--${purpose}${on ? ' is-on' : ''}`}
                        disabled={!available}
                        data-tip={available ? undefined : `На устройстве нет модуля ${PURPOSE_MODULE[purpose]}`}
                        onClick={() => onToggle(purpose)}
                    >
                        <span className="dot" />
                        {PURPOSE_NAMES[purpose]}
                    </button>
                );
            })}
        </div>
    );
}
