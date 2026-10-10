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
            detail = body?.detail ?? body?.error ?? detail;
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
};
