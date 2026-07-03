import { useCallback, useEffect, useState } from 'react';
import { neuralApi } from '../../api/client';
import type { ConfigSummary, ModelFile, NeuralConfig } from '../../api/types';
import { ConfigList } from './ConfigList';
import { ConfigEditor } from './ConfigEditor';
import { ImportConfigs } from './ImportConfigs';

const blankConfig = (): NeuralConfig => ({
    name: 'Новая конфигурация',
    model_path: '',
    model_width: 640,
    model_height: 640,
    thresholds: { nms: 0.45, confidence: 0.5 },
    superclasses: {},
    classes: {},
});

/** Раздел 1 — список конфигураций + редактор + создание. */
export function ConfigurationsSection() {
    const [items, setItems] = useState<ConfigSummary[]>([]);
    const [models, setModels] = useState<ModelFile[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState<NeuralConfig | null>(null);
    const [loading, setLoading] = useState(true);

    const reloadConfigs = useCallback(async () => {
        setLoading(true);
        try {
            const { configurations } = await neuralApi.listConfigurations();
            setItems(configurations);
            setSelectedId((cur) => cur ?? configurations[0]?.id ?? null);
        } finally {
            setLoading(false);
        }
    }, []);

    const reloadModels = useCallback(() => {
        neuralApi.listModels().then(setModels).catch(() => setModels([]));
    }, []);

    useEffect(() => {
        reloadConfigs();
        reloadModels();
    }, [reloadConfigs, reloadModels]);

    function selectExisting(id: string) {
        setCreating(null);
        setSelectedId(id);
    }

    function startCreate() {
        setCreating(blankConfig());
        setSelectedId(null);
    }

    /** Сохранение: создание/перезапись — merge; переименование id — replace-all. */
    const persist = useCallback(
        async (originalId: string | null, newId: string, config: NeuralConfig) => {
            if (!originalId || originalId === newId) {
                await neuralApi.importConfigurations({ [newId]: config }, 'merge');
            } else {
                // переименование: нет delete-ручки, поэтому пересобираем весь набор
                const { configurations } = await neuralApi.listConfigurations();
                const full = await Promise.all(
                    configurations.map(async (c) => [c.id, await neuralApi.getConfiguration(c.id)] as const),
                );
                const all: Record<string, NeuralConfig> = {};
                for (const [id, cfg] of full) if (id !== originalId) all[id] = cfg;
                all[newId] = config;
                await neuralApi.importConfigurations(all, 'replace');
            }
            setCreating(null);
            await reloadConfigs();
            setSelectedId(newId);
        },
        [reloadConfigs],
    );

    return (
        <div className="config-layout">
            <div className="config-sidebar">
                <button className="btn btn-accent" onClick={startCreate}>+ новая конфигурация</button>
                <ConfigList
                    items={items}
                    selectedId={creating ? null : selectedId}
                    loading={loading}
                    onSelect={selectExisting}
                />
                <ImportConfigs onImported={reloadConfigs} />
            </div>
            <div className="config-main">
                <ConfigEditor
                    configId={creating ? null : selectedId}
                    seed={creating}
                    models={models}
                    onRefreshModels={reloadModels}
                    onSave={persist}
                    onDiscardNew={() => setCreating(null)}
                />
            </div>
        </div>
    );
}