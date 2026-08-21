import { useMemo, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Select } from '../../app/Select';
import { Switch } from '../../app/Modal';
import { getDevices } from '../../services/devices';
import {
    PRODUCTION_NAMES,
    TYPE_NAMES,
    type CameraFormData,
    type StreamKey,
    type Validation,
} from './model';

export interface FieldsProps {
    form: CameraFormData;
    onChange: (patch: Partial<CameraFormData>) => void;
}

/** Доступность типов камер по модулям подключённых устройств. */
export function useTypeAvailability(): Record<number, { ok: boolean; reason: string }> {
    const devices = getDevices();
    const key = devices.map(d => d.id + d.modules.join()).join();
    return useMemo(() => {
        const hasModule = (m: string) => devices.some(d => d.modules.includes(m));
        return {
            1: { ok: devices.length > 0, reason: 'В системе нет устройств' },
            2: {
                ok: devices.length > 0 && hasModule('neural'),
                reason: devices.length > 0 ? 'Нет модуля технического зрения' : 'В системе нет устройств',
            },
            3: {
                ok: devices.length > 0 && hasModule('birdview'),
                reason: devices.length > 0 ? 'Нет модуля 360' : 'В системе нет устройств',
            },
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
}

/** Поле с подписью сверху: подпись объясняет, за что отвечает контрол. */
function Cell({ cap, children }: { cap: string; children: React.ReactNode }) {
    return (
        <label className="fcell">
            <span className="fcap">{cap}</span>
            {children}
        </label>
    );
}

function NumCell({ cap, value, onValue }: { cap: string; value: number; onValue: (n: number) => void }) {
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
                    title={shown ? 'Скрыть пароль' : 'Показать пароль'}
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
    /** В мастере имя задаётся, в панели правки его не трогают */
    withName?: boolean;
}

export function ConnectionFields({
    form, onChange, editMode, autoName, nameCheck, ipCheck, portCheck, withName = false,
}: ConnectionFieldsProps) {
    const types = useTypeAvailability();

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
                <Cell cap="Тип камеры">
                    <Select
                        value={String(form.type)}
                        onChange={v => onChange({ type: Number(v) })}
                        options={Object.entries(TYPE_NAMES).map(([value, name]) => ({
                            value,
                            label: name,
                            disabled: !types[Number(value)].ok,
                            hint: types[Number(value)].ok ? undefined : types[Number(value)].reason,
                        }))}
                    />
                </Cell>
            </div>
        </div>
    );
}

interface StreamFieldsProps extends FieldsProps {
    /** Выбранный слот потока — общий с подтаблицей камеры */
    stream: StreamKey;
    onStreamChange: (key: StreamKey) => void;
    /** Подписи каналов в селекте: «1 · 1280×960» */
    options: Array<{ key: StreamKey; label: string }>;
}

export function StreamFields({ form, onChange, stream, onStreamChange, options }: StreamFieldsProps) {
    const isMain = stream === 'main';
    const channel = isMain ? form.main_sub : form.sub_sub;
    const latency = isMain ? form.main_latency : form.sub_latency;
    const reconnect = isMain ? form.main_reconnect : form.sub_reconnect;
    const udp = isMain ? form.main_use_udp : form.sub_use_udp;

    return (
        <div className="fields">
            <div className="finline">
                <span className="fcap">Канал</span>
                <Select
                    value={stream}
                    onChange={v => onStreamChange(v as StreamKey)}
                    options={options.map(o => ({ value: o.key, label: o.label }))}
                />
            </div>

            <div className="frow frow--3">
                <NumCell
                    cap="Номер канала"
                    value={channel}
                    onValue={n => onChange(isMain ? { main_sub: n } : { sub_sub: n })}
                />
                <NumCell
                    cap="Задержка, мс"
                    value={latency}
                    onValue={n => onChange(isMain ? { main_latency: n } : { sub_latency: n })}
                />
                <NumCell
                    cap="Реконнект, с"
                    value={reconnect}
                    onValue={n => onChange(isMain ? { main_reconnect: n } : { sub_reconnect: n })}
                />
            </div>

            <label className="fsw">
                <Switch
                    on={udp}
                    onToggle={v => onChange(isMain ? { main_use_udp: v } : { sub_use_udp: v })}
                >
                    Передавать по UDP
                </Switch>
            </label>
        </div>
    );
}

interface RecordFieldsProps extends FieldsProps {
    stream: StreamKey;
}

export function RecordFields({ form, onChange, stream }: RecordFieldsProps) {
    // Пишется только первый слот: у второго media-center всегда держит to_record = false
    if (stream !== 'main') {
        return (
            <p className="hint" style={{ margin: 0 }}>
                В архив пишется только первый канал камеры. Выберите его в списке слева,
                чтобы изменить настройки записи.
            </p>
        );
    }

    return (
        <div className="fields">
            <label className="fsw">
                <Switch on={form.to_record} onToggle={v => onChange({ to_record: v })}>
                    Писать в архив
                </Switch>
            </label>
            {form.to_record && (
                <div className="frow">
                    <NumCell
                        cap="Длина сегмента, с"
                        value={form.main_segment}
                        onValue={n => onChange({ main_segment: n })}
                    />
                </div>
            )}
            <p className="hint" style={{ margin: 0 }}>
                Записи складываются на накопитель устройства-владельца камеры. Старые сегменты
                удаляются автоматически при заполнении диска.
            </p>
        </div>
    );
}
