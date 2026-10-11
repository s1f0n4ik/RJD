import { Fragment } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { Select, type SelectOption } from '../../app/Select';
import { navFor, useRole } from '../../app/role';
import { refreshNeuralStatus, useNeuralStatus, type NeuralDeviceStatus } from '../../app/neuralStatus';
import { getRouting, type Device } from '../../services/devices';
import { ToastProvider } from '../../features/birdview/components/common/Toast';
import { setNeuralDevice } from '../../features/neural/api/client';
import { JournalSection } from '../../features/neural/components/journal/JournalSection';
import { lastSeenTime, sinceLabel } from '../devices/model';
import { ConfigsScreen } from './ConfigsScreen';
import { InferenceScreen } from './InferenceScreen';
import { VideoStreamsScreen } from './VideoStreamsScreen';
import { NEURAL_SECTIONS, isNeuralSection, type NeuralSectionId } from './sections';
import { useNeuralDevice, type NeuralDevicePick } from './useNeuralDevice';
import './neural.css';

const LOCK_TIP = 'Закройте редактор, чтобы сменить устройство';

const plural = (n: number, one: string, few: string, many: string) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
};

/** Корень раздела «Техническое зрение» на /neural/<подраздел>; журнал живёт в мастере и устройства не требует */
export default function NeuralScreen() {
    const { section = '' } = useParams();
    const role = useRole();

    // Первый доступный роли подраздел: у наблюдателя это журнал
    if (!isNeuralSection(section)) {
        const first = navFor(role).find(i => i.to === '/neural')?.sub?.[0]?.to ?? `/neural/${NEURAL_SECTIONS[0].id}`;
        return <Navigate to={first} replace />;
    }

    return (
        <ToastProvider>
            <section className="screen nv-screen">
                {section === 'journal' ? <JournalSection /> : <DeviceSection section={section} />}
            </section>
        </ToastProvider>
    );
}

/** Нейросети, видеопотоки и инференс выбранного устройства */
function DeviceSection({ section }: { section: NeuralSectionId }) {
    const pick = useNeuralDevice();
    const [params] = useSearchParams();
    // Редактор видеопотока держит сессию на устройстве: пока он открыт, устройство не меняется
    const locked = section === 'streams' && params.has('edit');
    const device = pick.problem ? null : pick.device;
    if (device) setNeuralDevice(device.id);

    return (
        <>
            <DeviceBar pick={pick} locked={locked} />
            {!device ? <DeviceNotice pick={pick} /> : (
                // Смена устройства пересоздаёт подраздел: всё перечитывается с новой платы
                <Fragment key={device.id}>
                    {section === 'configs' && <ConfigsScreen />}
                    {section === 'streams' && <VideoStreamsScreen />}
                    {section === 'inference' && <Inference deviceId={device.id} />}
                </Fragment>
            )}
        </>
    );
}

function Inference({ deviceId }: { deviceId: string }) {
    const entry = useNeuralStatus()?.find(d => d.device_id === deviceId);
    return <InferenceScreen status={entry?.state === 'ok' ? entry.slots : null} onRefreshStatus={() => void refreshNeuralStatus()} />;
}

// Вариант списка: точка и подпись по сводке слотов устройства
function deviceOption(d: Device, st: NeuralDeviceStatus | undefined, fallback: boolean): SelectOption {
    const label = d.name || d.id;
    if (d.status !== 'online' || st?.state === 'offline') return { value: d.id, label, hint: `не в сети ${sinceLabel(d.last_seen)}`, muted: true };
    if (st?.state === 'no_module') return { value: d.id, label, hint: 'нет модуля neural', dot: 'warn' };
    const slots = st?.slots ?? [];
    const running = slots.filter(s => s.running).length;
    const failed = slots.filter(s => s.code !== 0).length;
    const hint = [
        fallback ? 'по умолчанию' : '',
        running ? `${running} в работе` : '',
        failed ? `${failed} с ошибкой` : '',
        st && !slots.length ? 'слотов нет' : '',
    ].filter(Boolean).join(' · ');
    return { value: d.id, label, hint: hint || undefined, dot: failed ? 'err' : running ? 'ok' : undefined };
}

function DeviceBar({ pick, locked }: { pick: NeuralDevicePick; locked: boolean }) {
    const status = useNeuralStatus();
    const { device, candidates, problem } = pick;
    const fallback = getRouting().neural;
    const options = candidates.map(d => deviceOption(d, status?.find(s => s.device_id === d.id), d.id === fallback));
    const chosen = device && (problem === null || problem === 'offline') ? device : null;
    const platform = problem === null ? device?.telemetry?.platform : undefined;
    const current = chosen ? options.find(o => o.value === chosen.id) : undefined;

    return (
        <div className="nv-devbar">
            <span className="nv-devcap">Устройство</span>
            <span className="nv-devsel">
                {locked && chosen ? (
                    <button type="button" className="uisel-btn" aria-disabled="true" data-tip={LOCK_TIP}>
                        {current?.dot && <span className={`dot ${current.dot}`} />}
                        <span className="uisel-val">{chosen.name || chosen.id}</span>
                        <Icon name="lock" size={13} className="nv-devlock" />
                    </button>
                ) : (
                    <Select value={chosen?.id ?? ''} options={options} onChange={pick.select} disabled={!candidates.length}
                        placeholder={candidates.length ? 'Выберите устройство' : 'Нет устройств с модулем'} />
                )}
            </span>
            {platform && (
                <span className="seps nv-devfacts">
                    <span>{platform.label}</span>
                    <span>{platform.npu_cores} {plural(platform.npu_cores, 'ядро', 'ядра', 'ядер')} NPU</span>
                </span>
            )}
            {chosen && (problem === 'offline'
                ? <span className="pill err"><span className="dot" />не в сети</span>
                : <span className="pill ok"><span className="dot" />в сети</span>)}
        </div>
    );
}

function DeviceNotice({ pick }: { pick: NeuralDevicePick }) {
    const navigate = useNavigate();
    const { device, problem, asked } = pick;
    const name = device?.name || device?.id || '';
    const seen = device?.last_seen ? `Последний ответ — ${lastSeenTime(device.last_seen)}.` : 'Устройство ещё ни разу не отвечало.';

    const [title, text] =
        problem === 'none' ? ['Модуль neural не назначен ни одному устройству', 'Журнал обнаружений работает без устройства. Нейросети, видеопотоки и инференс появятся, когда устройство с модулем neural будет в списке.']
            : problem === 'notfound' ? ['Устройство не найдено', `В ссылке указано устройство ${asked}, его нет в списке устройств. Выберите устройство в списке.`]
                : problem === 'nomod' ? [`На устройстве «${name}» нет модуля neural`, 'Ссылка ведёт на устройство без технического зрения. Выберите устройство в списке.']
                    : [`Устройство «${name}» не в сети`, `${seen} Выберите другое устройство или проверьте связь с платой.`];

    return (
        <div className="notice">
            <Icon name="warn" className="ico" />
            <h2>{title}</h2>
            <p>{text}</p>
            {(problem === 'none' || problem === 'offline') && (
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn--acc" onClick={() => navigate('/devices')}>Открыть устройства</button>
                    {problem === 'none' && <button className="btn" onClick={() => navigate('/neural/journal')}>Открыть журнал</button>}
                </div>
            )}
        </div>
    );
}
