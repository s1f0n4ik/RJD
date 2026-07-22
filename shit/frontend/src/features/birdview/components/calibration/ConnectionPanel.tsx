import type { BirdviewWs } from '../../hooks/useBirdviewWs';

/**
 * Панель подключения к калибратору.
 *
 * Отход от оригинала: WS поднимается автоматически при открытии страницы,
 * а панель двухсостоянийная — форма подключения либо адрес текущего
 * соединения с кнопкой «Отключиться». Отключение освобождает слот
 * калибратора: их ровно один на всех клиентов.
 */

interface ConnectionPanelProps {
    ws: BirdviewWs;
}

export function ConnectionPanel({ ws }: ConnectionPanelProps) {
    const connected = ws.status === 'connected';

    return (
        <section className="panel-block">
            <div className="block-header">
                <span className="block-icon">⌁</span>
                <span className="block-title">WebSocket</span>
            </div>

            {connected ? (
                <>
                    <div className="ws-connected-row">
                        <span className="ws-connected-label">Подключено</span>
                        <span className="ws-connected-url">{ws.url}</span>
                    </div>
                    <button className="btn btn-ghost" onClick={ws.disconnect}>
                        Отключиться
                    </button>
                </>
            ) : (
                <>
                    <div className="field-group">
                        <label className="field-label">Сервер</label>
                        <input
                            className="field-input"
                            type="text"
                            value={ws.url}
                            onChange={e => ws.setUrl(e.target.value)}
                        />
                    </div>
                    <div className="btn-row" style={{ display: 'flex', gap: 8 }}>
                        <button
                            className="btn btn-primary"
                            onClick={ws.connect}
                            disabled={ws.status === 'connecting'}
                        >
                            {ws.status === 'connecting' ? 'Подключение...' : 'Подключить'}
                        </button>
                        <button className="btn btn-ghost" onClick={ws.disconnect}>
                            Сбросить
                        </button>
                    </div>
                </>
            )}
        </section>
    );
}
