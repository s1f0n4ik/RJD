import { useMemo, type ReactNode } from 'react';
import { Link, useLocation, useOutletContext } from 'react-router-dom';
import { Icon } from '../app/Icons';
import { isAdmin } from '../app/role';
import { useSystem } from '../app/SystemContext';
import { formatDeviceDate, formatDeviceTime, useDeviceClock } from '../app/useDeviceClock';
import {
    useDisks, useLastDetections, useLinkerStatus, useNeuralStatus as useNeuralSummary,
} from '../screens/home/useHomeData';
import { CAMERA_STATUS } from '../utils/constants';
import { isProbeCamera } from '../utils/probeFilter';
import { aggClasses, classColor } from '../features/neural/components/journal/DetectionRow';
import { useClassResolver } from '../features/neural/components/journal/useClassResolver';
import { useCameraNames } from '../features/neural/components/journal/useCameraNames';
import { fmtTime } from '../features/neural/components/journal/format';
import type { ShellContext } from './MobileShell';

const GB = 1024 ** 3;
const fmtGb = (bytes: number) => (bytes >= 1024 * GB
    ? `${(bytes / (1024 * GB)).toFixed(1).replace('.', ',')} ТБ`
    : `${Math.round(bytes / GB)} ГБ`);

const plural = (n: number, one: string, few: string, many: string) => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
};

const isLive = (camera: { offline?: boolean; streams?: Record<string, { status?: number }> }) =>
    !camera.offline && Object.values(camera.streams ?? {}).some(s => s.status === CAMERA_STATUS.RUNNING);

// Скелет той же высоты, что и настоящее значение
const Sk = ({ w, h = 12, right }: { w: number; h?: 10 | 12 | 16; right?: boolean }) => (
    <span className={`skel${h === 16 ? ' h16' : h === 10 ? ' h10' : ''}`} style={{ width: w, marginLeft: right ? 'auto' : undefined, display: 'block' }} />
);

// Значение строки: число и подпись либо два скелета
const Value = ({ ready, big, small }: { ready: boolean; big: ReactNode; small: ReactNode }) => (
    ready
        ? <div className="v"><b>{big}</b>{small}</div>
        : <div className="v"><Sk w={64} h={16} right /><span style={{ display: 'block', height: 6 }} /><Sk w={48} h={10} right /></div>
);

const SkRow = () => (
    <div className="m-li">
        <div className="t"><Sk w={120} h={16} /><span style={{ display: 'block', height: 8 }} /><Sk w={180} h={10} /></div>
        <Sk w={60} h={16} />
    </div>
);

export default function HomeScreen() {
    const { username, role, onLogout } = useOutletContext<ShellContext>();
    const { state } = useLocation();
    const { connected, cameras: allCameras, devices } = useSystem();
    const { unixMs, source } = useDeviceClock();
    const neural = useNeuralSummary();
    const linker = useLinkerStatus();
    const disks = useDisks(devices);
    const { items: lastDetections, available: journalAvailable, loaded: journalLoaded } = useLastDetections(5);
    const { resolve } = useClassResolver();
    const { cameraName } = useCameraNames();

    const cameras = useMemo(() => allCameras.filter(c => !isProbeCamera(c.display_name)), [allCameras]);
    const dead = cameras.filter(c => !isLive(c));
    const offline = devices.filter(d => d.status !== 'online');
    const closed = (state as { closed?: string } | null)?.closed;
    const admin = isAdmin(role);

    // Диск с наибольшим архивом: у миньонов записи нет
    const disksLoaded = devices.length === 0 || Object.keys(disks).length > 0;
    const disk = Object.values(disks).filter(Boolean).sort((a, b) => b!.records_bytes - a!.records_bytes)[0] ?? null;
    const other = disk ? Math.max(0, disk.used_bytes - disk.records_bytes - disk.journal_bytes) : 0;
    const share = (bytes: number) => (disk?.total_bytes ? (bytes / disk.total_bytes) * 100 : 0);

    return (
        <section className="m-screen">
            <div className="m-scroll">
                {closed && (
                    <div className="banner is-info">
                        <Icon name="lock" />
                        <span>Раздел «{closed}» открывается только на рабочем месте. Вы на главной.</span>
                    </div>
                )}
                {offline.length > 0 && (
                    <div className="banner">
                        <Icon name="warn" />
                        <span>{offline.map(d => d.name).join(', ')} не в сети.</span>
                    </div>
                )}

                <div className="m-grp">Состояние</div>

                <div className="m-stat">
                    <Icon name="clock" className="ico lead" />
                    <div className="k">Время изделия<small>{unixMs === null ? <Sk w={90} h={10} /> : source === 'can' ? 'шина CAN' : 'время сервера, шина молчит'}</small></div>
                    <Value ready={unixMs !== null} big={formatDeviceTime(unixMs)} small={formatDeviceDate(unixMs)} />
                    <span className={`dot ${unixMs === null ? '' : source === 'can' ? 'ok' : 'warn'}`} />
                </div>

                <div className="m-stat">
                    <Icon name="cam" className="ico lead" />
                    <div className="k">Камеры<small>{!connected ? <Sk w={120} h={10} /> : cameras.length === 0 ? 'не добавлены' : dead.length ? `без потока: ${dead.map(c => c.display_name || c.id).join(', ')}` : 'все в работе'}</small></div>
                    <Value ready={connected} big={<>{cameras.length - dead.length} <span className="muted">/ {cameras.length}</span></>} small="в эфире" />
                    <span className={`dot ${!connected || cameras.length === 0 ? '' : dead.length ? 'warn' : 'ok'}`} />
                </div>

                {admin && (
                    <div className="m-stat">
                        <Icon name="dev" className="ico lead" />
                        <div className="k">Устройства<small>{devices.length === 0 ? 'не добавлены' : offline.length ? `${offline.map(d => d.name).join(', ')} не отвечает` : 'все в сети'}</small></div>
                        <Value ready big={<>{devices.length - offline.length} <span className="muted">/ {devices.length}</span></>} small="в сети" />
                        <span className={`dot ${offline.length ? 'err' : devices.length ? 'ok' : ''}`} />
                    </div>
                )}

                <div className="m-stat">
                    <Icon name="eye" className="ico lead" />
                    <div className="k">Техническое зрение<small>{neural === undefined ? <Sk w={110} h={10} /> : neural ? (neural.failed ? `${neural.failed} с ошибкой` : neural.slots ? 'все потоки в работе' : 'потоков нет') : 'модуль не отвечает'}</small></div>
                    <Value ready={neural !== undefined} big={neural ? neural.running : '—'} small={neural ? plural(neural.running, 'поток', 'потока', 'потоков') : ''} />
                    <span className={`dot ${neural === undefined ? '' : !neural || neural.failed ? 'err' : neural.running ? 'ok' : ''}`} />
                </div>

                {admin && (
                    <div className="m-stat">
                        <Icon name="360" className="ico lead" />
                        <div className="k">Система 360<small>{linker === undefined ? <Sk w={90} h={10} /> : linker ? (linker.running ? (linker.dualOutput ? 'оба вида' : linker.viewMode === 'surround' ? 'объём' : 'сверху') : 'вывод остановлен') : 'модуль не отвечает'}</small></div>
                        <Value ready={linker !== undefined} big={linker?.running ? 'эфир' : 'стоп'} small="вывод" />
                        <span className={`dot ${linker === undefined ? '' : linker?.running ? 'ok' : linker ? '' : 'err'}`} />
                    </div>
                )}

                {admin && devices.length > 0 && (
                    <div className="m-stat">
                        <Icon name="arch" className="ico lead" />
                        <div className="k">Накопитель<small className="seps">{!disksLoaded ? <Sk w={100} h={10} /> : disk ? <><span>{fmtGb(disk.total_bytes)}</span><span>порог {disk.max_used_percent} %</span></> : <span>служба хранения не отвечает</span>}</small></div>
                        <Value ready={disksLoaded} big={disk ? `${Math.round(disk.used_percent)} %` : '—'} small={disk ? 'занято' : ''} />
                        <span className={`dot ${!disksLoaded ? '' : !disk ? 'err' : disk.used_percent >= disk.max_used_percent ? 'err' : 'ok'}`} />
                        <div className="wide">
                            <div className="bar">
                                {disk && (
                                    <>
                                        <i className="dk-ar" style={{ width: `${share(disk.records_bytes)}%` }} />
                                        <i className="dk-jr" style={{ width: `${share(disk.journal_bytes)}%` }} />
                                        <i className="dk-ot" style={{ width: `${share(other)}%` }} />
                                    </>
                                )}
                            </div>
                            <div className="m-lg">
                                {disk ? (
                                    <>
                                        <span><i className="dk-ar" />Архив<span className="num">{fmtGb(disk.records_bytes)}</span></span>
                                        {disk.journal_reserve_bytes > 0 && <span><i className="dk-jr" />Журнал<span className="num">{fmtGb(disk.journal_bytes)}</span></span>}
                                        <span><i className="dk-ot" />Прочее<span className="num">{fmtGb(other)}</span></span>
                                        <span><i className="dk-fr" />Свободно<span className="num">{fmtGb(disk.free_gb * GB)}</span></span>
                                    </>
                                ) : (
                                    <><Sk w={60} h={10} /><Sk w={70} h={10} /><Sk w={80} h={10} /></>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {(!journalLoaded || journalAvailable) && (
                    <>
                        <div className="m-grp">
                            Последние обнаружения
                            {journalLoaded && <Link className="m-lnk" to="/neural/journal">Журнал ›</Link>}
                        </div>
                        {!journalLoaded && <><SkRow /><SkRow /><SkRow /></>}
                        {journalLoaded && lastDetections.map(det => {
                            const classes = aggClasses(det, resolve);
                            return (
                                <Link className="m-li" key={det.id} to="/neural/journal" state={{ open: det.id }}>
                                    <div className="t">
                                        <b className="num" style={{ fontSize: 14 }}>
                                            {fmtTime(det.ts)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{cameraName(det.camera_id)}</span>
                                        </b>
                                        <span className="seps">
                                            {classes.map((c, i) => <span key={i}>{c.name || '—'} {c.cf.toFixed(2).replace('.', ',')}</span>)}
                                            {classes.length === 0 && <span>без объектов</span>}
                                        </span>
                                    </div>
                                    {classes[0] && (
                                        <span className="tag"><i className="sw-col" style={{ background: classColor(classes[0]) }} />{classes[0].name || '—'}</span>
                                    )}
                                </Link>
                            );
                        })}
                        {journalLoaded && lastDetections.length === 0 && <div className="m-cnt">за сегодня обнаружений нет</div>}
                    </>
                )}

                <div className="m-who">
                    <div className="m-avatar">{(username.slice(0, 2) || 'ОП').toUpperCase()}</div>
                    <div className="t">
                        <b>{username || 'Оператор'}</b>
                        <span>{admin ? 'Администратор' : 'Наблюдатель'}</span>
                    </div>
                    <button className="btn btn--ghost" onClick={onLogout}>
                        <Icon name="exit" size={18} />Выйти
                    </button>
                </div>
            </div>
        </section>
    );
}
