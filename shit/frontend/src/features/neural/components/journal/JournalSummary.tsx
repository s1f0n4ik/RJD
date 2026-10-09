import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../../../../app/Icons';
import { journalApi } from '../../api/journal';
import type { JournalFilters, JournalSummary as Summary } from '../../api/journal-types';
import type { ClassOption } from './useClassResolver';

interface Props {
  filters: JournalFilters;
  classOptions: ClassOption[];
  superOf: (key: string | null) => { name: string; color: string } | null;
  cameraName: (id: string) => string;
  deviceName: (id: string) => string;
}

interface Row {
  key: string;
  name: string;
  value: number;
  color?: string;
  top?: boolean;
  sub?: boolean;
}

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const pct1 = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')}%`;
const two = (n: number) => String(n).padStart(2, '0');
const dayLabel = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

function plural(n: number, one: string, few: string, many: string) {
  const m = n % 10;
  const h = n % 100;
  return m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 12 || h > 14) ? few : many;
}

function VerdictBar({ t, f, u }: { t: number; f: number; u: number }) {
  const sum = t + f + u || 1;
  return (
    <div className="js-vbar">
      {t > 0 && <i className="t" style={{ width: `${(t / sum) * 100}%` }} data-tip={`Подтверждено: ${fmt(t)}`} />}
      {f > 0 && <i className="f" style={{ width: `${(f / sum) * 100}%` }} data-tip={`Ложных: ${fmt(f)}`} />}
      {u > 0 && <i className="u" style={{ width: `${(u / sum) * 100}%` }} data-tip={`Не проверено: ${fmt(u)}`} />}
    </div>
  );
}

function Legend({ t, f, u }: { t: number; f: number; u: number }) {
  return (
    <div className="js-legend">
      <span><i className="t" />подтверждено <b>{fmt(t)}</b></span>
      <span><i className="f" />ложных <b>{fmt(f)}</b></span>
      <span><i className="u" />не проверено <b>{fmt(u)}</b></span>
    </div>
  );
}

function Card({ title, aside, children }: { title: string; aside: string; children: ReactNode }) {
  return (
    <div className="js-card">
      <div className="js-card-h">
        <h3>{title}</h3>
        <span className="spacer">{aside}</span>
      </div>
      <div className="js-card-b">{children}</div>
    </div>
  );
}

function Rows({ head, rows, total }: { head: string; rows: Row[]; total: number }) {
  const max = Math.max(1, ...rows.filter((r) => !r.top).map((r) => r.value));
  return (
    <div className="js-rows">
      <div className="js-row head">
        <span>{head}</span>
        <span className="wide">Обнаружений</span>
        <span>Доля</span>
      </div>
      {rows.map((r) => (
        <div className={`js-row${r.top ? ' top' : ''}`} key={r.key}>
          <span className={`n${r.sub ? ' sub' : ''}`}>
            {r.color && <i style={{ background: r.color }} />}
            {r.name}
          </span>
          {r.top ? <span /> : <span className="js-bar"><i style={{ width: `${(r.value / max) * 100}%` }} /></span>}
          <span className="v">{fmt(r.value)}</span>
          <span className="p">{pct(r.value, total)}</span>
        </div>
      ))}
    </div>
  );
}

interface ColumnsProps {
  title: string;
  aside: string;
  values: number[];
  labels: string[];
  axis: string[];
}

// Столбики 72 px: пик — акцентом, остальные приглушены, нули — линией
function Columns({ title, aside, values, labels, axis }: ColumnsProps) {
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  const w = 100 / values.length;
  return (
    <div className="js-cols">
      <div className="js-cols-h">
        <span>{title}</span>
        <b>{aside}</b>
      </div>
      <svg viewBox="0 0 100 72" preserveAspectRatio="none" role="img" aria-label={title}>
        {values.map((v, i) => {
          const h = v ? Math.max(3, (v / max) * 70) : 2;
          return (
            <rect
              key={i}
              className={!v ? 'z' : i === peak ? 'pk' : ''}
              x={i * w + w * 0.14}
              y={72 - h}
              width={w * 0.72}
              height={h}
              data-tip={`${labels[i]}: ${fmt(v)}`}
            />
          );
        })}
      </svg>
      <div className="js-axis">
        {axis.map((a, i) => <span key={i}>{a}</span>)}
      </div>
    </div>
  );
}

/** Сводка за период: те же фильтры, что у списка. */
export function JournalSummary({ filters, classOptions, superOf, cameraName, deviceName }: Props) {
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    journalApi
      .summary(filters)
      .then((s) => {
        if (alive) setData(s);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [filters]);

  if (err) {
    return (
      <div className="empty">
        <Icon name="warn" className="ico" />
        <b>Сводка недоступна</b>
        <p>{err}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="js-body">
        <span className="skel" style={{ height: 96 }} />
        <span className="skel" style={{ height: 320 }} />
      </div>
    );
  }
  if (data.total === 0) {
    return (
      <div className="empty">
        <Icon name="empty" className="ico" />
        <b>Обнаружений нет</b>
      </div>
    );
  }

  const { total, verdicts: V, hours, days } = data;
  const checked = (V.true + V.false) / total;
  const peak = hours.indexOf(Math.max(...hours));
  const peakRange = `${two(peak)}:00–${two((peak + 1) % 24)}:00`;
  const perDay = total / Math.max(1, days.length);
  const cams = data.cameras.length;

  const camRows: Row[] = data.devices.flatMap((d) => [
    { key: `d:${d.device_id}`, name: deviceName(d.device_id), value: d.count, top: true },
    ...data.cameras
      .filter((c) => c.device_id === d.device_id)
      .map((c) => ({ key: `c:${c.device_id}:${c.camera_id}`, name: cameraName(c.camera_id), value: c.count, sub: true })),
  ]);

  const groups = new Map<string, Summary['classes']>();
  for (const c of data.classes) {
    const key = c.superclass ?? '';
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const classColor = (cid: number | null, name: string | null) =>
    classOptions.find((o) => o.cid === cid && o.name === name)?.color ?? classOptions.find((o) => o.cid === cid)?.color;
  const clsRows: Row[] = [...groups.entries()]
    .map(([key, list]) => ({ key, list, sum: list.reduce((a, c) => a + c.count, 0) }))
    .sort((a, b) => b.sum - a.sum)
    .flatMap(({ key, list, sum }) => {
      const sup = superOf(key || null);
      const items = list.map((c) => ({
        key: `${key}:${c.class_id}:${c.class_name}`,
        name: c.class_name || String(c.class_id ?? '—'),
        value: c.count,
        sub: !!sup,
        color: sup ? undefined : classColor(c.class_id, c.class_name),
      }));
      return sup ? [{ key: `s:${key}`, name: sup.name, value: sum, color: sup.color }, ...items] : items;
    });
  const classCount = data.classes.length;

  const dayKeys = days.map((d) => d.day);
  const mid = dayKeys[Math.floor(dayKeys.length / 2)];

  return (
    <div className="js-body">
      <div className="js-kpi">
        <div>
          <span className="k">Обнаружений</span>
          <span className="v">{fmt(total)}</span>
          <span className="s seps">
            <span>{days.length} {plural(days.length, 'день', 'дня', 'дней')}</span>
            <span>в среднем {fmt(perDay)} в день</span>
          </span>
        </div>
        <div>
          <span className="k">Проверено</span>
          <span className="v">{pct1(checked)}</span>
          <VerdictBar t={V.true} f={V.false} u={V.unverified} />
          <Legend t={V.true} f={V.false} u={V.unverified} />
        </div>
        <div>
          <span className="k">Пиковый час</span>
          <span className="v">{peakRange}</span>
          <span className="s seps">
            <span>{fmt(hours[peak])}</span>
            <span>{pct(hours[peak], total)} всех обнаружений</span>
          </span>
        </div>
        <div>
          <span className="k">Источники</span>
          <span className="v">{cams} {plural(cams, 'камера', 'камеры', 'камер')}</span>
          <span className="s seps">
            <span>{data.devices.length} {plural(data.devices.length, 'устройство', 'устройства', 'устройств')}</span>
            {data.devices.length === 1 && <span>{deviceName(data.devices[0].device_id)}</span>}
          </span>
        </div>
      </div>

      <div className="js-three">
        <Card title="По камерам" aside={`${cams} ${plural(cams, 'камера', 'камеры', 'камер')}`}>
          <Rows head="Источник" rows={camRows} total={total} />
          <div className="js-rows">
            <div className="js-row head vrow">
              <span className="full">Проверено по камерам</span>
            </div>
            {data.cameras.map((c) => (
              <div className="js-row vrow" key={`${c.device_id}:${c.camera_id}`}>
                <span className="n">{cameraName(c.camera_id)}</span>
                <VerdictBar t={c.true} f={c.false} u={c.unverified} />
                <span className="p">{pct1((c.true + c.false) / (c.count || 1))}</span>
              </div>
            ))}
          </div>
          <Legend t={V.true} f={V.false} u={V.unverified} />
        </Card>
        <Card title="По классам" aside={`${classCount} ${plural(classCount, 'класс', 'класса', 'классов')}`}>
          <Rows head="Класс" rows={clsRows} total={total} />
        </Card>
        <Card title="По времени" aside={`${days.length} ${plural(days.length, 'день', 'дня', 'дней')}`}>
          <Columns
            title="По времени суток"
            aside={`пик ${peakRange}`}
            values={hours}
            labels={hours.map((_, i) => `${two(i)}:00`)}
            axis={['00', '06', '12', '18', '23']}
          />
          <Columns
            title="По дням"
            aside={`в среднем ${fmt(perDay)}`}
            values={days.map((d) => d.count)}
            labels={dayKeys.map(dayLabel)}
            axis={dayKeys.length > 2 ? [dayLabel(dayKeys[0]), dayLabel(mid), dayLabel(dayKeys[dayKeys.length - 1])] : dayKeys.map(dayLabel)}
          />
        </Card>
      </div>
    </div>
  );
}
