import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../../app/Modal';
import { Select } from '../../app/Select';
import { type Camera } from './model';

interface Subnet {
    prefix: string;
    address: string;
    iface: string;
}

interface OnvifFound {
    ip: string;
    port: number;
    name?: string;
    model?: string;
    manufacturer?: string;
}

interface PortFound {
    ip: string;
    open_ports: number[];
    has_rtsp: boolean;
    vendor?: string;
}

type Stage = 'idle' | 'onvif' | 'ports' | 'done';

/**
 * Имя из ONVIF-scopes часто начинается с производителя: «HIKVISION DS-…».
 * Стрим скана manufacturer не заполняет, поэтому префикс — единственный
 * источник вендора; он снимается, остаток становится читаемым именем.
 */
const VENDOR_PREFIXES: Array<[RegExp, string]> = [
    [/^hikvision[\s_-]*/i, 'Hikvision'],
    [/^hik[\s_-]+/i, 'Hikvision'],
    [/^dahua[\s_-]*/i, 'Dahua'],
    [/^dh[\s_-]+/i, 'Dahua'],
    [/^ace[\s_-]+/i, 'ACE'],
];

const normalizeVendor = (raw?: string): string | null => {
    if (!raw) return null;
    for (const [re, vendor] of VENDOR_PREFIXES) {
        if (re.test(raw)) return vendor;
    }
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
};

const parseOnvifName = (found: OnvifFound): { name: string | null; vendor: string | null } => {
    let vendor = normalizeVendor(found.manufacturer);
    let name = found.name?.trim() || null;

    if (name) {
        for (const [re, v] of VENDOR_PREFIXES) {
            if (re.test(name)) {
                vendor = vendor ?? v;
                name = name.replace(re, '').trim() || null;
                break;
            }
        }
    }
    return { name: name || found.model?.trim() || null, vendor };
};

/** Единая строка находки: ONVIF и порт-скан приводятся к одному виду. */
interface ScanRow {
    ip: string;
    name: string | null;
    vendor: string | null;
    chips: Array<{ label: string; ok: boolean }>;
}

interface ScanModalProps {
    cameras: Camera[];
    onClose: () => void;
    /** Забрать находку: адрес и распознанный вендор уходят в мастер */
    onPick: (found: { ip: string; vendor: string | null }) => void;
    /** «Добавить» открывает мастер; из мастера — «Выбрать», только заносит данные */
    pickLabel?: string;
}

export function ScanModal({ cameras, onClose, onPick, pickLabel = 'Добавить' }: ScanModalProps) {
    const [subnets, setSubnets] = useState<Subnet[]>([]);
    const [subnet, setSubnet] = useState('');
    const [stage, setStage] = useState<Stage>('idle');
    const [progress, setProgress] = useState({ scanned: 0, total: 0 });
    const [currentSubnet, setCurrentSubnet] = useState('');
    const [onvifFound, setOnvifFound] = useState<OnvifFound[]>([]);
    const [portFound, setPortFound] = useState<PortFound[]>([]);
    const sourceRef = useRef<EventSource | null>(null);

    const usedIps = useMemo(() => new Set(cameras.map(c => c.ip_adress)), [cameras]);

    const startScan = useCallback((net: string) => {
        sourceRef.current?.close();
        setStage('onvif');
        setProgress({ scanned: 0, total: 0 });
        setCurrentSubnet('');
        setOnvifFound([]);
        setPortFound([]);

        // Пустой subnet — сервер просканирует все локальные подсети
        const es = new EventSource(
            net ? `/api/scan/stream?subnet=${encodeURIComponent(net)}` : '/api/scan/stream',
        );
        sourceRef.current = es;

        es.onmessage = e => {
            const msg = JSON.parse(e.data);
            switch (msg.stage) {
                case 'onvif_start': setStage('onvif'); break;
                case 'onvif_done': setOnvifFound(msg.cameras || []); break;
                case 'ports_start':
                    setStage('ports');
                    setProgress({ scanned: 0, total: msg.total });
                    break;
                case 'ports_progress':
                    setProgress({ scanned: msg.scanned, total: msg.total });
                    if (msg.subnet) setCurrentSubnet(msg.subnet);
                    if (msg.found?.length) setPortFound(prev => [...prev, ...msg.found]);
                    break;
                case 'error':
                case 'done':
                    setStage('done');
                    es.close();
                    sourceRef.current = null;
                    break;
            }
        };
        es.onerror = () => {
            setStage('done');
            es.close();
            sourceRef.current = null;
        };
    }, []);

    // Первый запуск: список подсетей не обязателен, без него сканируются все
    useEffect(() => {
        let alive = true;
        (async () => {
            let list: Subnet[] = [];
            try {
                const res = await fetch('/api/scan/subnets');
                if (res.ok) list = await res.json();
            } catch { /* не критично */ }
            if (!alive) return;
            setSubnets(list);

            // По умолчанию — подсеть уже добавленных камер
            const camPrefixes = new Set(
                cameras
                    .map(c => c.ip_adress)
                    .filter((ip): ip is string => typeof ip === 'string' && ip.split('.').length === 4)
                    .map(ip => ip.split('.').slice(0, 3).join('.') + '.'),
            );
            const preferred = list.find(s => camPrefixes.has(s.prefix));
            const initial = preferred ? preferred.prefix : '';
            setSubnet(initial);
            startScan(initial);
        })();
        return () => {
            alive = false;
            sourceRef.current?.close();
            sourceRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const busy = stage === 'onvif' || stage === 'ports';

    // ONVIF надёжнее порт-скана: при совпадении адресов строка одна
    const rows: ScanRow[] = useMemo(() => {
        const result: ScanRow[] = onvifFound.map(f => {
            const { name, vendor } = parseOnvifName(f);
            return {
                ip: f.ip,
                name,
                vendor,
                chips: [{ label: `ONVIF :${f.port}`, ok: true }],
            };
        });
        const seen = new Set(result.map(r => r.ip));
        for (const f of portFound) {
            if (seen.has(f.ip)) continue;
            const chips = [
                ...(f.has_rtsp ? [{ label: 'RTSP 554', ok: true }] : []),
                ...f.open_ports.filter(p => p !== 554).map(p => ({ label: `порт ${p}`, ok: false })),
            ];
            result.push({ ip: f.ip, name: null, vendor: normalizeVendor(f.vendor), chips });
        }
        return result;
    }, [onvifFound, portFound]);

    const alreadyAdded = rows.filter(r => usedIps.has(r.ip)).length;
    const percent = progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0;

    const vendClass = (vendor: string) =>
        vendor === 'Hikvision' ? 'vend'
        : vendor === 'Dahua' ? 'vend vend--warn'
        : 'vend vend--dim';

    return (
        <Modal title="Поиск камер в сети" className="scan-modal modal--mid" onClose={onClose}>
            <div className="scan-body">
                <aside className="scan-side">
                    <div>
                        <div className="cap">Подсеть</div>
                        <Select
                            value={subnet}
                            disabled={busy}
                            onChange={setSubnet}
                            options={[
                                { value: '', label: 'Все подсети' },
                                ...subnets.map(s => ({ value: s.prefix, label: `${s.prefix}0/24 · ${s.iface}` })),
                            ]}
                        />
                    </div>

                    <div>
                        <div className="cap">Ход сканирования</div>
                        <div className="scan-bar">
                            <i style={{ width: stage === 'done' ? '100%' : stage === 'ports' ? `${percent}%` : '4%' }} />
                        </div>
                        <span className="num muted" style={{ fontSize: 11.5 }}>
                            {stage === 'onvif' && 'опрос ONVIF…'}
                            {stage === 'ports' && `порты · ${progress.scanned} из ${progress.total}${currentSubnet ? ` · ${currentSubnet}` : ''}`}
                            {stage === 'done' && 'завершено'}
                        </span>
                    </div>

                    <div>
                        <div className="cap">Найдено</div>
                        <div className="scan-kv"><span>По ONVIF</span><b>{onvifFound.length}</b></div>
                        <div className="scan-kv"><span>По портам</span><b>{rows.length - onvifFound.length}</b></div>
                        <div className="scan-kv"><span>Уже в системе</span><b>{alreadyAdded}</b></div>
                    </div>

                    <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {busy ? (
                            <button
                                className="btn btn--sm"
                                onClick={() => {
                                    sourceRef.current?.close();
                                    sourceRef.current = null;
                                    setStage('done');
                                }}
                            >
                                Остановить
                            </button>
                        ) : (
                            <button className="btn btn--sm" onClick={() => startScan(subnet)}>Повторить</button>
                        )}
                        <button className="btn btn--sm btn--ghost" onClick={onClose}>Закрыть</button>
                    </div>
                </aside>

                <div className="scan-list">
                    {rows.length === 0 ? (
                        <div className="empty" style={{ height: '100%' }}>
                            {busy ? (
                                <>
                                    <span className="spin" />
                                    <b>Ищем камеры</b>
                                    <p>Опрашиваем сеть — найденные устройства появятся здесь по мере обнаружения.</p>
                                </>
                            ) : (
                                <>
                                    <b>Камеры не найдены</b>
                                    <p>Проверьте, что камера включена и находится в той же сети, либо выберите другую подсеть.</p>
                                </>
                            )}
                        </div>
                    ) : (
                        rows.map(row => (
                            <div className="scan-row" key={row.ip}>
                                <div className="who">
                                    <div className="top">
                                        {row.name
                                            ? <b>{row.name}</b>
                                            : <b className="anon">Не назвалась</b>}
                                        {row.vendor && <span className={vendClass(row.vendor)}>{row.vendor}</span>}
                                    </div>
                                    <div className="sub">
                                        <span className="addr">{row.ip}</span>
                                        {row.chips.map(chip => (
                                            <span key={chip.label} className={`scan-chip${chip.ok ? ' ok' : ''}`}>
                                                {chip.label}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                {usedIps.has(row.ip)
                                    ? <span className="num muted" style={{ fontSize: 11.5 }}>добавлено</span>
                                    : (
                                        <button
                                            className="btn btn--sm btn--acc"
                                            onClick={() => onPick({ ip: row.ip, vendor: row.vendor })}
                                        >
                                            {pickLabel}
                                        </button>
                                    )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </Modal>
    );
}
