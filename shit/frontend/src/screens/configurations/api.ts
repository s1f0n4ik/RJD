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
    ceiling_s: number;
}

// Тип обнаружения CAN 1–8 и класс опасности 1–4; 0 — не задано
export interface RsmClassRule {
    type: number;
    danger: number;
}

export interface RsmTable {
    defaults: RsmClassRule;
    // Ключ суперкласса → класс опасности
    superclasses: Record<string, number>;
    // Имя класса → тип и опасность
    classes: Record<string, RsmClassRule>;
    // id камеры → номер 1–8
    cameras: Record<string, number>;
}

export interface IskraZone {
    number: number;
    name: string;
    color: string;
    // Зона вне многоугольников
    default: boolean;
}

export interface IskraTable {
    // Класс → код 28163
    codes: Record<string, number>;
    // id камеры → роль
    roles: Record<string, number>;
    // Порядок — опасность: первая самая опасная
    zones: IskraZone[];
}

export interface RulesSettings {
    stitch: RuleStitch;
    websocket?: RuleClassFilter & { late_s: number };
    can?: RuleClassFilter;
    modbus?: RuleModbus;
    // Нет у мастера старше таблиц соответствий
    table?: RsmTable | IskraTable;
}

export const isIskraTable = (t?: RsmTable | IskraTable): t is IskraTable => !!t && 'zones' in t;

export interface CfRules extends CfRule {
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
    event: 'confirmed' | 'removed' | 'record';
    detection_id: number;
    class_name: string;
    camera_id: string;
    status: FeedStatus;
    confidence?: number;
    more?: number[];
    code?: number;
    camera_mask?: number;
    zone?: number;
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

export interface CfState {
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
    async saveRules(id: string, settings: RulesSettings): Promise<CfRules> {
        return unwrap<CfRules>(
            await fetch(`/api/configurations/${encodeURIComponent(id)}/rules`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            }),
        );
    },
};
