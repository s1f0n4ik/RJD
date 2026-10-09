import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
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
  // Точка вместо квадрата — у классов
  round?: boolean;
  // Цвет полосы; нет — акцентный
  bar?: string;
  // Метка суперкласса слева от класса
  mark?: string;
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

interface RowsProps {
  head: string;
  rows: Row[];
  total: number;
  // Строки — кнопки выбора; picked — выбранная
  onPick?: (key: string) => void;
  picked?: string | null;
}

function Rows({ head, rows, total, onPick, picked }: RowsProps) {
  const max = Math.max(1, ...rows.filter((r) => !r.top).map((r) => r.value));
  return (
    <div className="js-rows">
      <div className="js-row head">
        <span>{head}</span>
        <span className="wide">Обнаружений</span>
        <span>Доля</span>
      </div>
      {rows.map((r) => {
        const Tag = onPick ? 'button' : 'div';
        return (
        <Tag
          className={`js-row${r.top ? ' top' : ''}${onPick ? ' js-pick' : ''}${picked === r.key ? ' is-on' : ''}`}
          key={r.key}
          type={onPick ? 'button' : undefined}
          onClick={onPick ? () => onPick(r.key) : undefined}
        >
          <span
            className={`n${r.sub ? ' js-sub' : ''}${r.mark ? ' mark' : ''}`}
            style={r.mark ? ({ '--sc': r.mark } as CSSProperties) : undefined}
          >
            {r.color && <i className={r.round ? 'dot-c' : undefined} style={{ background: r.color }} />}
            {r.name}
          </span>
          {r.top ? <span /> : <span className="js-bar"><i style={{ width: `${(r.value / max) * 100}%`, background: r.bar }} /></span>}
          <span className="v">{fmt(r.value)}</span>
          <span className="p">{pct(r.value, total)}</span>
        </Tag>
        );
      })}
    </div>
  );
}

// Часы суток на всю свободную высоту колонки: пик — акцентом, нули — линией
interface HoursProps {
  hours: number[];
  // Выбранный день; null — сумма за период
  day: string | null;
  onReset: () => void;
}

function HoursChart({ hours, day, onReset }: HoursProps) {
  const max = Math.max(1, ...hours);
  const peak = hours.indexOf(Math.max(...hours));
  return (
    <div className="js-hours">
      <div className="js-cols-h">
        <span className="seps">
          <span>По времени суток</span>
          {day && <span>{dayLabel(day)}</span>}
        </span>
        {day && (
          <button type="button" className="js-reset" onClick={onReset}>
            Все дни
          </button>
        )}
        <b>пик {two(peak)}:00–{two((peak + 1) % 24)}:00</b>
      </div>
      <div className="js-plot" role="img" aria-label="По времени суток">
        {hours.map((v, i) => (
          <i
            key={i}
            className={!v ? 'z' : i === peak ? 'pk' : undefined}
            style={v ? { height: `${Math.max(3, (v / max) * 100)}%` } : undefined}
            data-tip={`${two(i)}:00: ${fmt(v)}`}
          />
        ))}
      </div>
      <div className="js-axis">
        {['00', '06', '12', '18', '23'].map((a) => <span key={a}>{a}</span>)}
      </div>
    </div>
  );
}

/** Сводка за период: те же фильтры, что у списка. */
export function JournalSummary({ filters, classOptions, superOf, cameraName, deviceName }: Props) {
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // День, за который показаны часы; null — сумма за период
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    setDay(null);
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
  const supRows: Row[] = [...groups.entries()]
    .filter(([key]) => superOf(key || null))
    .map(([key, list]) => {
      const sup = superOf(key)!;
      return { key, name: sup.name, value: list.reduce((a, c) => a + c.count, 0), color: sup.color, bar: sup.color };
    })
    .sort((a, b) => b.value - a.value);
  const classColor = (cid: number | null, name: string | null) =>
    classOptions.find((o) => o.cid === cid && o.name === name)?.color ?? classOptions.find((o) => o.cid === cid)?.color;
  const clsRows: Row[] = data.classes.map((c) => {
    const sup = superOf(c.superclass);
    const color = classColor(c.class_id, c.class_name) ?? sup?.color ?? '#5b9dff';
    return {
      key: `${c.superclass}:${c.class_id}:${c.class_name}`,
      name: c.class_name || String(c.class_id ?? '—'),
      value: c.count,
      color,
      round: true,
      bar: color,
      mark: sup?.color,
    };
  });
  const classCount = data.classes.length;

  const dayRows: Row[] = days.map((d) => ({ key: d.day, name: dayLabel(d.day), value: d.count }));
  const pickedDay = days.length > 1 && days.some((d) => d.day === day) ? day : null;
  const shownHours = days.find((d) => d.day === pickedDay)?.hours ?? hours;

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
          {supRows.length > 0 && <Rows head="Суперкласс" rows={supRows} total={total} />}
          <Rows head="Класс" rows={clsRows} total={total} />
        </Card>
        <Card title="По времени" aside={`${days.length} ${plural(days.length, 'день', 'дня', 'дней')}`}>
          <HoursChart hours={shownHours} day={pickedDay} onReset={() => setDay(null)} />
          <Rows
            head="День"
            rows={dayRows}
            total={total}
            onPick={days.length > 1 ? (key) => setDay((cur) => (cur === key ? null : key)) : undefined}
            picked={pickedDay}
          />
        </Card>
      </div>
    </div>
  );
}
