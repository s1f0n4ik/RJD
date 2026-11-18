import type { Dictionaries } from '../../features/krsps/utils/dictionaries';

// Конфигурации изделия: /api/configurations бэкенда мастера (шлюз АС КРСПС + правила мастера обнаружений)

export interface CfModule {
    id: string;
    title: string;
    transport: string;
    // Только у активной конфигурации
    connected?: boolean;
    url?: string;
    error?: string;
}

export interface CfItem {
    id: string;
    title: string;
    description: string;
    active: boolean;
    modules: CfModule[];
}

export interface CfRule {
    id: string;
    title: string;
    description: string;
    modules: string[];
}

export interface RuleStitch {
    gap_s: number;
    distance: number;
}

export interface RuleClassFilter {
    enabled: boolean;
    classes_all: boolean;
    // Имена классов и ключи суперклассов
    classes: string[];
}

export interface RuleModbus {
    enabled: boolean;
    // Искра: запись не позже
    ceiling_s?: number;
    // КЖТ: повтор последнего состава
    period_s?: number;
}

// Числа одной конфигурации нейросети; строки нет — id + 1 (суперкласс — место + 1, зона — id), 0 — пусто
export interface ModelTable {
    // id класса → число
    classes: Record<string, number>;
    // Место суперкласса в списке конфигурации → число
    superclasses: Record<string, number>;
    // id зоны каталога → число; 0 — вне зон, без строки пусто; нет у мастера старше зон
    zones?: Record<string, number>;
}

export interface RsmTable {
    // Конфигурация нейросети → числа; конфигурации нет — всё по +1
    models: Record<string, ModelTable>;
    // Правило РСМ: конфигурация нейросети → id класса → опасность вместо суперкласса
    danger_override: Record<string, Record<string, number>>;
    // id камеры → номер 1–8
    cameras: Record<string, number>;
}

export interface IskraCamera {
    // Бит маски камер записи 28163
    bit: number;
    name: string;
    // Камера технического зрения; пусто — не назначена
    camera_id: string;
}

export interface IskraTable {
    models: Record<string, ModelTable>;
    cameras: IskraCamera[];
}

export interface KztTable {
    // Коды навесного: суперкласс по месту, класс без суперкласса по id
    models: Record<string, ModelTable>;
    // Камера КЖТ; пусто — все камеры
    camera_id: string;
    // Рабочая зона каталога; null — весь кадр
    zone_id: number | null;
    // Ключ суперкласса грузов; пусто — всё навесное
    cargo_superclass: string;
    // Классы грузов слов 18–20
    cargo: string[];
    // Код навесного → допустимые классы грузов; строки нет — любые
    allowed: Record<string, string[]>;
}

export type RulesTable = RsmTable | IskraTable | KztTable;

export interface RulesSettings {
    stitch: RuleStitch;
    websocket?: RuleClassFilter & { late_s: number };
    can?: RuleClassFilter;
    modbus?: RuleModbus;
    // Нет у мастера старше решений 63–70
    table?: RulesTable;
    // РСМ: type, danger; Искра: code, zone; КЖТ: attachment
    dictionaries?: Dictionaries;
}

export const isIskraTable = (t?: RulesTable): t is IskraTable => !!t && Array.isArray((t as IskraTable).cameras);
export const isKztTable = (t?: RulesTable): t is KztTable => !!t && 'cargo_superclass' in t;

// Камер в таблице правил: РСМ — номера, Искра — биты, КЖТ — выбранная камера
export function tableCameraCount(t?: RulesTable): number {
    if (!t) return 0;
    if (isKztTable(t)) return t.camera_id ? 1 : 0;
    return Array.isArray(t.cameras) ? t.cameras.length : Object.keys(t.cameras ?? {}).length;
}

// Словари для расшифровки чисел; у Искры камеры — словарь cameras по битам
export function dictionariesOf(settings?: RulesSettings): Dictionaries {
    const dicts = { ...settings?.dictionaries };
    const table = settings?.table;
    if (isIskraTable(table)) dicts.cameras = table.cameras.map(c => ({ number: c.bit, name: c.name }));
    return dicts;
}

export interface CfRules extends CfRule {
    context: string;
    settings: RulesSettings;
    defaults: RulesSettings;
    saved_at: number | null;
    env: { late_s: number; silence_s: number; link_lost_s: number };
}

export type FeedStatus = 'new' | 'sent' | 'accepted' | 'rejected' | 'dropped' | 'late';

export interface FeedEntry {
    seq: number;
    t: number;
    module: string;
    event: 'confirmed' | 'removed' | 'record' | 'state';
    detection_id: number;
    class_name: string;
    camera_id: string;
    status: FeedStatus;
    confidence?: number;
    more?: number[];
    code?: number;
    camera_mask?: number;
    zone?: number;
    // КЖТ: коды навесного и число грузов слотов
    attachments?: number[];
    cargo?: number[];
}

export interface FeedCounters {
    sent: number;
    accepted: number;
    rejected: number;
    filtered: number;
    dropped: number;
}

export interface CfLink {
    active: string | null;
    rules: string;
    devices: { id: string; connected: boolean; packets_per_s: number; delay_ms: number }[];
    master: { tracks: number; open: number; opened: number; session: number };
    gateway: {
        connected: boolean;
        connected_at: number | null;
        lost_at: number | null;
        queue: number;
        queue_max: number;
        rejected: number;
        address: string;
    };
    feed: FeedEntry[];
    counters: Record<string, FeedCounters>;
}

export interface CfMaster {
    // Конфигурация шлюза, которую видит мастер; null — шлюз ещё ни разу не ответил
    active: string | null;
    rules: string;
    title: string;
    description: string;
    open: number;
    devices: number;
    available: CfRule[];
}

export interface CfTransition {
    id: string;
    profile_id: string;
    previous_profile_id?: string | null;
    previous_profile_name?: string | null;
    phase: 'stopping' | 'loading' | 'starting' | 'repairing' | 'complete';
    error: string | null;
}

export interface CfState {
    context: string;
    transition?: CfTransition | null;
    delivery?: { device_id: string; state: string; error?: string | null }[];
    gateway: boolean;
    active: string;
    items: CfItem[];
    master: CfMaster | null;
}

async function unwrap<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let detail = res.statusText;
        try {
            const body = await res.json();
            const d = body?.detail ?? body?.error ?? detail;
            // Отказ проверки настроек — список ошибок полей
            detail = Array.isArray(d) ? d.map((e: { msg?: string }) => e.msg).join('; ') : d;
        } catch {
            /* тело не JSON — оставляем statusText */
        }
        throw new Error(`${res.status} · ${detail}`);
    }
    return (await res.json()) as T;
}

export const configurationsApi = {
    async recover(action: 'repair' | 'retry', transitionId: string, profileId?: string): Promise<void> {
        await unwrap(await fetch(`/api/config/transition/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transition_id: transitionId, profile_id: profileId }),
        }));
    },
    async list(): Promise<CfState> {
        return unwrap<CfState>(await fetch('/api/configurations'));
    },
    async select(id: string): Promise<CfState> {
        return unwrap<CfState>(
            await fetch('/api/configurations/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
            }),
        );
    },
    async link(): Promise<CfLink> {
        return unwrap<CfLink>(await fetch('/api/configurations/link'));
    },
    async getRules(id: string): Promise<CfRules> {
        return unwrap<CfRules>(await fetch(`/api/configurations/${encodeURIComponent(id)}/rules`));
    },
    async saveRules(id: string, settings: RulesSettings, context: string): Promise<CfRules> {
        return unwrap<CfRules>(
            await fetch(`/api/configurations/${encodeURIComponent(id)}/rules?context=${encodeURIComponent(context)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            }),
        );
    },
};
