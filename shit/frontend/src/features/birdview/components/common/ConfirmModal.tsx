import { Modal } from '../../../../app/Modal';

/** Подтверждение действия на общей модалке оболочки */

interface ConfirmModalProps {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    /** Красная кнопка подтверждения: удаление и другие необратимые действия */
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmModal({
    title,
    message,
    confirmText = 'Подтвердить',
    cancelText = 'Отмена',
    danger,
    onConfirm,
    onCancel,
}: ConfirmModalProps) {
    return (
        <Modal
            title={title}
            onClose={onCancel}
            className="modal--confirm"
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onCancel}>{cancelText}</button>
                    <button className={`btn ${danger ? 'btn--err' : 'btn--acc'}`} onClick={onConfirm}>{confirmText}</button>
                </>
            }
        >
            <div className="modal-b">
                <p className="modal-text">{message}</p>
            </div>
        </Modal>
    );
}
