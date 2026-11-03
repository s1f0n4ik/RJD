import type { CPPCamera, CameraStream } from '../../types';
import type { ActiveDesc, NeuralConfig, VideoStream } from '../../features/neural/api/types';
import type { SavedLayout } from '../../hooks/Layouts';
import type { CfTransition, RulesSettings } from './api';
import type { NeuralModel } from './TablePanels';
import { sameJson } from '../../utils/same-json';

export { sameJson as sameSource } from '../../utils/same-json';

export type Source = Record<string, unknown>;
export type Definition = Record<string, Record<string, Source>>;
export interface ProfileVersion {
    id: number;
    number: number;
    label: string;
    created: number;
}
export interface Profile {
    id: string;
    name: string;
    active: boolean;
    version_id: number;
    versions: ProfileVersion[];
    overrides: number;
}
export interface Entry {
    body: Source;
    state: string;
    profile_newer?: boolean;
}
export interface Workspace {
    profile: { id: string; name: string; version_id: number };
    version: ProfileVersion;
    base: Definition;
    entities: Record<string, Record<string, Entry>>;
    removed: { kind: string; key: string; profile_newer?: boolean; in_profile: boolean }[];
    broken: { kind: string; key: string; field: string; ref: string }[];
    assets: Record<
        string,
        { name: string; size: number; info: { input_width?: number; input_height?: number } | null }
    >;
    context: string;
    revision: string;
    rules_defaults: Record<string, RulesSettings>;
}
export interface ConfigStatus {
    context: string;
    transition: CfTransition | null;
    devices: { device_id: string; state: string; error?: string | null; applied?: string; wanted?: string }[];
}
export interface Place {
    name: string;
    modules: string[];
}
export interface CameraSource {
    place: string;
    camera: Omit<CPPCamera, 'streams'>;
    streams: Record<string, CameraStream>;
}
export interface NeuralSource extends Omit<NeuralConfig, 'model_path'> {
    model_file: string;
    _assets?: Record<string, string>;
}
export interface StreamSource extends VideoStream {
    place: string;
}
export interface SlotSource extends ActiveDesc {
    place: string;
}
export interface ProjectionSource {
    place: string;
    name?: string;
    width: number;
    height: number;
    rotation?: number;
    cameras: Record<string, { name?: string; region?: number[]; camera_id?: string; calibration?: string }>;
    machine?: { rect?: number[] };
    images?: { name: string; rect: number[] }[];
    top?: { resolution?: { width: number; height: number } };
    surround?: { resolution?: { width: number; height: number }; model?: { source?: string } };
    preset?: string;
}
export interface OutputConfig {
    cameras?: Record<string, string>;
    fps?: number;
    stream_id?: string;
    stream_name?: string;
    width?: number;
    height?: number;
    dual_output?: boolean;
    rotation?: number;
}
export interface OutputSource {
    active?: string;
    configs: Record<string, OutputConfig>;
}
export interface Change {
    kind: string;
    key: string;
    body?: Source;
    reset?: boolean;
}

export class LibraryRequestError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

async function json<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = body.detail;
        throw new LibraryRequestError(
            response.status,
            Array.isArray(detail)
                ? detail.map((item: { msg?: string }) => item.msg).join('; ')
                : detail || `Ошибка ${response.status}`,
        );
    }
    return response.json();
}

export const libraryApi = {
    profiles: () => fetch('/api/config/profiles').then(json<{ active: string | null; profiles: Profile[] }>),
    status: () => fetch('/api/config/status').then(json<ConfigStatus>),
    workspace: (id: string) => fetch(`/api/config/profiles/${encodeURIComponent(id)}/workspace`).then(json<Workspace>),
    save: (workspace: Workspace, changes: Change[]) =>
        fetch(`/api/config/profiles/${encodeURIComponent(workspace.profile.id)}/passport`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: workspace.context, revision: workspace.revision, changes }),
        }).then(json<{ snapshot: Workspace; application_error: string | null }>),
    activate: (id: string) =>
        fetch('/api/config/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile_id: id }),
        }).then(json<{ ok: boolean; transition: CfTransition }>),
};

export function effectiveDefinition(workspace: Workspace): Definition {
    return Object.fromEntries(
        Object.entries(workspace.entities).map(([kind, items]) => [
            kind,
            Object.fromEntries(Object.entries(items).map(([key, entry]) => [key, entry.body])),
        ]),
    );
}

export function entries<T>(definition: Definition, kind: string): [string, T][] {
    return Object.entries(definition[kind] ?? {}) as [string, T][];
}

export function entity<T>(definition: Definition, kind: string, key: string): T | undefined {
    return definition[kind]?.[key] as T | undefined;
}

export function mergeSources<T>(base: T, patch: unknown): T {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
    const result = { ...base } as Source;
    for (const [key, value] of Object.entries(patch)) {
        result[key] =
            value && typeof value === 'object' && !Array.isArray(value)
                ? mergeSources(result[key] ?? {}, value)
                : value;
    }
    return result as T;
}

export function profileRules(
    workspace: Workspace,
    definition: Definition,
): { id: string; settings: RulesSettings | null } {
    const id = String(definition.machine?.settings?.active_integration ?? '');
    const source = definition.rules?.[id];
    const defaults = workspace.rules_defaults[id];
    return {
        id,
        settings: source || defaults ? (mergeSources(defaults ?? {}, source) as RulesSettings) : null,
    };
}

export function modelCatalog(definition: Definition): NeuralModel[] {
    return entries<NeuralSource>(definition, 'neural_config').map(([id, config]) => ({
        id,
        name: config.name || id,
        file: config.model_file,
        classes: Object.entries(config.classes ?? {})
            .map(([key, value]) => ({ id: Number(key), name: value.name, superclass: value.superclass ?? '' }))
            .sort((a, b) => a.id - b.id),
        superclasses: Object.entries(config.superclasses ?? {}).map(([key, value]) => ({
            key,
            name: value.name,
            color: value.color ?? '',
        })),
        zones: (config.zones ?? []).map((zone) => ({ id: zone.id, name: zone.name, color: zone.color })),
        sources: entries<SlotSource>(definition, 'neural_slot')
            .filter(([, slot]) => slot.config_id === id)
            .map(([key, slot]) => {
                const stream = entity<StreamSource>(definition, 'video_stream', slot.stream_id);
                return {
                    name: stream?.name || slot.stream_id,
                    slot: key,
                    cameras: (stream?.tiles ?? []).map(
                        (tile) =>
                            entity<CameraSource>(definition, 'camera', tile.camera)?.camera.display_name || tile.camera,
                    ),
                };
            }),
    }));
}

export function passportChanges(workspace: Workspace, draft: Definition, resets: Set<string>): Change[] {
    const saved = effectiveDefinition(workspace);
    const changes: Change[] = [];
    for (const ref of resets) {
        const [kind, ...parts] = ref.split('/');
        changes.push({ kind, key: parts.join('/'), reset: true });
    }
    for (const [kind, items] of Object.entries(draft))
        for (const [key, body] of Object.entries(items)) {
            if (!resets.has(`${kind}/${key}`) && !sameJson(body, saved[kind]?.[key]))
                changes.push({ kind, key, body });
        }
    return changes;
}

export const timezoneLabel = (minutes: number) =>
    `UTC${minutes < 0 ? '−' : '+'}${Math.floor(Math.abs(minutes) / 60)}${minutes % 60 ? ':' + String(Math.abs(minutes) % 60).padStart(2, '0') : ''}`;
export type ProfileLayout = SavedLayout;
