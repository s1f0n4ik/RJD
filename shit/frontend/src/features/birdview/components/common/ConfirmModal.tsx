/** Модалка подтверждения в теме страницы. Разметка та же, что у остальных модалок. */

interface ConfirmModalProps {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmModal({
    title,
    message,
    confirmText = 'Подтвердить',
    cancelText = 'Отмена',
    onConfirm,
    onCancel,
}: ConfirmModalProps) {
    return (
        <div className="modal-backdrop" onClick={onCancel}>
            <div className="modal-window" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">{title}</span>
                    <button className="toast-close" onClick={onCancel}>✕</button>
                </div>

                <div className="modal-body">
                    <p className="modal-text">{message}</p>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onCancel}>{cancelText}</button>
                    <button className="btn btn-primary" onClick={onConfirm}>{confirmText}</button>
                </div>
            </div>
        </div>
    );
}
