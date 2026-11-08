import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../../app/Modal';
import { Select } from '../../app/Select';
import { ipToNumber, type Camera } from './model';
import { loadScan, saveScan, scanTimeLabel, type OnvifFound, type PortFound, type ScanSnapshot } from './scan-cache';

interface Subnet {
    prefix: string;
    address: string;
    iface: string;
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
    source: 'onvif' | 'ports';
    // Строка из прошлого поиска, свежий её ещё не подтвердил
    stale: boolean;
}

/** Строки одной выдачи по адресу; ONVIF надёжнее порт-скана: при совпадении адресов строка одна. */
function buildRows(onvif: OnvifFound[], ports: PortFound[], stale: boolean): Map<string, ScanRow> {
    const rows = new Map<string, ScanRow>();
    for (const f of onvif) {
        const { name, vendor } = parseOnvifName(f);
        rows.set(f.ip, { ip: f.ip, name, vendor, chips: [{ label: `ONVIF :${f.port}`, ok: true }], source: 'onvif', stale });
    }
    for (const f of ports) {
        if (rows.has(f.ip)) continue;
        const chips = [
            ...(f.has_rtsp ? [{ label: 'RTSP 554', ok: true }] : []),
            ...f.open_ports.filter(p => p !== 554).map(p => ({ label: `порт ${p}`, ok: false })),
        ];
        rows.set(f.ip, { ip: f.ip, name: null, vendor: normalizeVendor(f.vendor), chips, source: 'ports', stale });
    }
    return rows;
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
    // Прошлый поиск показывается сразу, пока идёт новый
    const [initial] = useState(loadScan);
    const [base, setBase] = useState<ScanSnapshot | null>(initial);
    const [subnets, setSubnets] = useState<Subnet[]>([]);
    const [subnet, setSubnet] = useState(initial?.subnet ?? '');
    const [stage, setStage] = useState<Stage>(initial ? 'onvif' : 'idle');
    const [progress, setProgress] = useState({ scanned: 0, total: 0 });
    const [currentSubnet, setCurrentSubnet] = useState('');
    const [onvifFound, setOnvifFound] = useState<OnvifFound[]>([]);
    const [portFound, setPortFound] = useState<PortFound[]>([]);
    const sourceRef = useRef<EventSource | null>(null);

    const usedIps = useMemo(() => new Set(cameras.map(c => c.ip_adress)), [cameras]);

    const startScan = useCallback((net: string, prev: ScanSnapshot | null) => {
        sourceRef.current?.close();
        const fresh = { onvif: [] as OnvifFound[], ports: [] as PortFound[] };
        setBase(prev && prev.subnet === net ? prev : null);
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
                case 'onvif_done':
                    fresh.onvif = msg.cameras || [];
                    setOnvifFound(fresh.onvif);
                    break;
                case 'ports_start':
                    setStage('ports');
                    setProgress({ scanned: 0, total: msg.total });
                    break;
                case 'ports_progress':
                    setProgress({ scanned: msg.scanned, total: msg.total });
                    if (msg.subnet) setCurrentSubnet(msg.subnet);
                    if (msg.found?.length) {
                        fresh.ports = [...fresh.ports, ...msg.found];
                        setPortFound(fresh.ports);
                    }
                    break;
                case 'done':
                    // Законченный поиск заменяет прежний
                    saveScan({ subnet: net, at: Date.now(), ...fresh });
                    setBase(null);
                    setStage('done');
                    es.close();
                    sourceRef.current = null;
                    break;
                case 'error':
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

            // Прошлый поиск годится, пока его подсеть есть на плате
            const usable = initial && (initial.subnet === '' || list.some(s => s.prefix === initial.subnet)) ? initial : null;
            if (!usable) setBase(null);

            // По умолчанию — подсеть прошлого поиска, иначе подсеть уже добавленных камер
            const camPrefixes = new Set(
                cameras
                    .map(c => c.ip_adress)
                    .filter((ip): ip is string => typeof ip === 'string' && ip.split('.').length === 4)
                    .map(ip => ip.split('.').slice(0, 3).join('.') + '.'),
            );
            const preferred = list.find(s => camPrefixes.has(s.prefix));
            const net = usable ? usable.subnet : preferred ? preferred.prefix : '';
            setSubnet(net);
            startScan(net, usable);
        })();
        return () => {
            alive = false;
            sourceRef.current?.close();
            sourceRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const busy = stage === 'onvif' || stage === 'ports';

    // Пока идёт новый поиск, строки прошлого остаются, свежая находка перекрывает их
    const rows: ScanRow[] = useMemo(() => {
        const merged = base ? buildRows(base.onvif, base.ports, true) : new Map<string, ScanRow>();
        buildRows(onvifFound, portFound, false).forEach((row, ip) => merged.set(ip, row));
        return [...merged.values()].sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));
    }, [base, onvifFound, portFound]);

    const free = rows.filter(r => !usedIps.has(r.ip));
    const added = rows.filter(r => usedIps.has(r.ip));
    const percent = progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0;

    const vendClass = (vendor: string) =>
        vendor === 'Hikvision' ? 'vend'
        : vendor === 'Dahua' ? 'vend vend--warn'
        : 'vend vend--dim';

    const renderRow = (row: ScanRow, isAdded: boolean) => (
        <div className={`scan-row${row.stale ? ' is-stale' : ''}${isAdded ? ' is-added' : ''}`} key={row.ip}>
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
            {isAdded
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
    );

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
                            {stage === 'ports' && (
                                <span className="seps">
                                    <span>порты</span>
                                    <span>{progress.scanned} из {progress.total}</span>
                                    {currentSubnet && <span>{currentSubnet}</span>}
                                </span>
                            )}
                            {stage === 'done' && 'завершено'}
                        </span>
                        {base && <span className="num muted scan-old">прошлый поиск от {scanTimeLabel(base.at)}</span>}
                    </div>

                    <div>
                        <div className="cap">Найдено</div>
                        <div className="scan-kv"><span>По ONVIF</span><b>{rows.filter(r => r.source === 'onvif').length}</b></div>
                        <div className="scan-kv"><span>По портам</span><b>{rows.filter(r => r.source === 'ports').length}</b></div>
                        <div className="scan-kv"><span>Уже в системе</span><b>{added.length}</b></div>
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
                            <button className="btn btn--sm" onClick={() => startScan(subnet, loadScan())}>Повторить</button>
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
                        <>
                            {busy && (
                                <div className="scan-sync">
                                    <span className="spin" />
                                    <span>Обновляем поиск</span>
                                </div>
                            )}
                            {free.map(row => renderRow(row, false))}
                            {free.length === 0 && !busy && <div className="scan-none">Свободных камер не найдено</div>}
                            {added.length > 0 && (
                                <>
                                    <div className="scan-sep">
                                        <span className="eyebrow">Уже в системе</span>
                                        <span className="cam-count">{added.length}</span>
                                    </div>
                                    {added.map(row => renderRow(row, true))}
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>
        </Modal>
    );
}
