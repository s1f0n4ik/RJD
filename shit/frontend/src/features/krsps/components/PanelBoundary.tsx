import React from 'react';

interface Props {
  // Смена ключа пересоздаёт предохранитель: перешли в другой раздел — ошибка
  // предыдущего не должна на нём висеть.
  resetKey: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

// Раздел страницы не должен уносить с собой всю страницу. Шлюз развивается,
// его JSON меняется, и панель, встретившая ответ незнакомой формы, обязана
// сказать об этом, а не оставить белый экран.
class PanelBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Раздел не отрисовался</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-alert">{error.message}</div>
          <div className="krsps-note" style={{ marginTop: 12 }}>
            Чаще всего это значит, что страница новее работающего шлюза и ждёт полей, которых тот ещё не
            отдаёт. Помогает пересборка message-gateway. Остальные разделы работают.
          </div>
          <div className="krsps-actions" style={{ marginTop: 12 }}>
            <button type="button" className="krsps-btn krsps-btn--ghost" onClick={() => this.setState({ error: null })}>
              Повторить
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default PanelBoundary;
