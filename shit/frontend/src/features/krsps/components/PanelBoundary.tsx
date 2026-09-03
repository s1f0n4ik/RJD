import React from 'react';

interface Props {
  // Смена ключа пересоздаёт предохранитель: ошибка прошлого раздела не висит на новом
  resetKey: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

// Раздел, встретивший ответ незнакомой формы, сообщает об этом сам, а не роняет экран
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
      <div className="card">
        <div className="card-h"><h3>Раздел не отрисовался</h3></div>
        <div className="card-b">
          <div className="banner is-err">{error.message}</div>
          <p className="hint" style={{ marginTop: 12 }}>
            Страница новее работающего шлюза и ждёт полей, которых тот не отдаёт. Нужна пересборка message-gateway.
          </p>
        </div>
        <div className="card-f">
          <button type="button" className="btn btn--ghost spacer" onClick={() => this.setState({ error: null })}>
            Повторить
          </button>
        </div>
      </div>
    );
  }
}

export default PanelBoundary;
