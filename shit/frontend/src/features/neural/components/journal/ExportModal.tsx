import { useEffect, useState } from 'react';
import { Modal, Switch } from '../../../../app/Modal';
import type { SelectOption } from '../../../../app/Select';
import { useDownloads } from '../../../../app/DownloadsContext';
import { useToast } from '../../../birdview/components/common/Toast';
import { JOURNAL_JOBS, exportFilters, journalApi } from '../../api/journal';
import type { JournalDetection } from '../../api/journal-types';
import { detClass } from './DetectionRow';
import { FrameWithBoxes, previewShot } from './FrameWithBoxes';
import { FilterFields, periodLabel, useJournalFilters } from './JournalFilters';
import type { FilterState } from './JournalFilters';
import type { ClassMeaning, ClassOption } from './useClassResolver';
import { fmtDateTime } from './format';

interface Props {
  /** Фильтры журнала на момент открытия; дальше модалка живёт своими */
  initial: FilterState;
  deviceOptions: SelectOption[];
  cameraOptions: SelectOption[];
  configOptions: SelectOption[];
  optionsFor: (configId?: string) => ClassOption[];
  legendFor: (configId?: string) => Record<string, { name: string; color: string }>;
  resolve: (configId: string | null, cid: number) => ClassMeaning;
  cameraName: (id: string) => string;
  onClose: () => void;
}

const plural = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? 'кадр' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'кадра' : 'кадров';

/** Архив кадров по фильтрам: задача устройства, прогресс — в плашке загрузок. */
export function ExportModal({ initial, deviceOptions, cameraOptions, configOptions, optionsFor, legendFor, resolve, cameraName, onClose }: Props) {
  const toast = useToast();
  const { start } = useDownloads();
  const fh = useJournalFilters(initial);
  const { state, filters } = fh;
  const classOptions = optionsFor(state.configId || undefined);

  const [boxes, setBoxes] = useState(true);
  const [data, setData] = useState(true);
  const [total, setTotal] = useState<number | null>(null);
  const [sample, setSample] = useState<JournalDetection | null>(null);
  const [busy, setBusy] = useState(false);

  // Счётчик и первый кадр — по фильтрам модалки, не журнала
  useEffect(() => {
    let alive = true;
    setTotal(null);
    journalApi
      .list(filters, { limit: 1, order: 'desc' })
      .then((res) => {
        if (!alive) return;
        setTotal(res.total);
        setSample(res.detections[0] ?? null);
      })
      .catch(() => {
        if (alive) setTotal(0);
      });
    return () => {
      alive = false;
    };
  }, [filters]);

  const sampleShot = sample ? previewShot(sample) : null;
  const sampleClass = sample ? detClass(sample, resolve) : null;

  const submit = async () => {
    if (!total) return;
    setBusy(true);
    try {
      const title = `Обнаружения · ${total} ${plural(total)}`;
      const subtitle = periodLabel(state);
      const body = {
        ...exportFilters(filters),
        boxes,
        data,
        legend: legendFor(state.configId || undefined),
        title,
        subtitle,
      };
      await start(JOURNAL_JOBS, title, subtitle, () => journalApi.export(body));
      onClose();
    } catch (e) {
      toast('Выгрузка не запущена', e instanceof Error ? e.message : String(e), 'err');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Скачать обнаружения"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Отмена</button>
          <span className="spacer" />
          <button className="btn btn--acc" disabled={!total || busy} onClick={() => void submit()}>
            {total ? `Скачать ${total} ${plural(total)}` : 'Скачать'}
          </button>
        </>
      }
    >
      <div className="modal-b jx">
        <div className="jx-fields">
          <FilterFields f={fh} deviceOptions={deviceOptions} cameraOptions={cameraOptions} configOptions={configOptions} classOptions={classOptions} over />
          <span className="fld j-found">
            <span className="k">Найдено</span>
            <span className="v">{total ?? '…'}</span>
          </span>
        </div>

        <div className="jx-pick">
          <div className="jx-opts">
            <span className="eyebrow">Нанести на кадры</span>
            <div className="jx-opt">
              <Switch on={boxes} onToggle={setBoxes}>Рамки объектов</Switch>
              <p className="hint">Прямоугольник цветом класса и подпись с уверенностью, как в просмотрщике</p>
            </div>
            <div className="jx-opt">
              <Switch on={data} onToggle={setData}>Время и координаты</Switch>
              <p className="hint">Плашка в углу кадра: время записи и GPS, как у кадров для шлюза</p>
            </div>
          </div>
          <div className="jx-prev">
            {sample ? (
              <>
                <div className="jx-frame">
                  <FrameWithBoxes
                    shot={sampleShot && (boxes ? sampleShot : { ...sampleShot, box: null })}
                    color={sampleClass!.color}
                    name={sampleClass!.name}
                  />
                  {data && (
                    <span className="jx-plate">
                      Время: {fmtDateTime(sample.started_at)}
                      <br />
                      GPS: {sample.gps ? `${sample.gps.lat.toFixed(5)}, ${sample.gps.lon.toFixed(5)}` : 'нет данных'}
                    </span>
                  )}
                </div>
                <span className="jx-cap">{cameraName(sample.camera_id)} · последний кадр выборки</span>
              </>
            ) : (
              <div className="jx-frame is-empty">{total === 0 ? 'Кадров нет' : '…'}</div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
