import { api, type CameraPatchBody } from '../../services/api';
import { deviceForCameraType } from '../../services/devices';
import {
    type Camera,
    type CameraFormData,
    RECORD_PATH,
    deviceOf,
    formToPayload,
} from './model';

/**
 * Сохранение камеры. Для новой — создание на устройстве по маршруту типа.
 * Для существующей — PATCH владельцу, а при смене типа камеры возможна
 * миграция: модуль нового типа живёт на другом устройстве, PATCH владельцу
 * вернул бы «тип не поддерживается». Тогда создаём на целевом устройстве
 * и после успеха удаляем у прежнего владельца.
 */
export async function saveCamera(
    form: CameraFormData,
    cameraId: string,
    original: Camera | null,
): Promise<{ message: string; warning?: string }> {
    if (!original) {
        await api.createCamera(formToPayload(form, cameraId));
        return { message: `Камера ${cameraId} добавлена` };
    }

    const ownerDevice = deviceOf(original);
    let migrationTarget: string | null = null;
    if (Number(form.type) !== Number(original.type)) {
        try {
            const routed = deviceForCameraType(Number(form.type));
            if (routed !== ownerDevice) migrationTarget = routed;
        } catch {
            // Маршрута для типа нет — оставляем PATCH владельцу,
            // осмысленная ошибка придёт от него
        }
    }

    if (migrationTarget) {
        const payload = formToPayload(
            { ...form, password: form.password || original.password },
            cameraId,
        );
        await api.createCamera(payload, migrationTarget);
        try {
            await api.deleteCamera(cameraId, ownerDevice);
            return { message: `Камера ${cameraId} перенесена на устройство модуля нового типа` };
        } catch {
            return {
                message: `Камера ${cameraId} создана на новом устройстве`,
                warning: `Не удалена на прежнем — удалите ${cameraId} на старом устройстве вручную`,
            };
        }
    }

    const body: CameraPatchBody = {};

    if (form.display_name !== original.display_name) {
        body.meta = { display_name: form.display_name };
    }

    const passwordChanged = !!form.password;
    const criticalChanged =
        form.ip_adress !== original.ip_adress ||
        form.port !== original.port ||
        form.user !== original.user ||
        form.password !== original.password ||
        form.production !== original.production ||
        form.type !== original.type ||
        form.main_sub !== original.streams.main.sub ||
        form.main_latency !== original.streams.main.latency ||
        form.main_use_udp !== original.streams.main.use_udp ||
        form.main_reconnect !== original.streams.main.reconnect ||
        form.sub_sub !== original.streams.sub.sub ||
        form.sub_latency !== original.streams.sub.latency ||
        form.sub_use_udp !== original.streams.sub.use_udp ||
        form.sub_reconnect !== original.streams.sub.reconnect ||
        form.main_segment !== original.streams.main.segment ||
        form.to_record !== original.streams.main.to_record ||
        RECORD_PATH !== original.streams.main.record_path;

    if (passwordChanged || criticalChanged) {
        body.critical = {
            ip_adress: form.ip_adress,
            port: form.port,
            user: form.user,
            password: form.password,
            production: form.production,
            type: form.type,
            streams: {
                main: {
                    sub: form.main_sub,
                    type: 1,
                    latency: form.main_latency,
                    use_udp: form.main_use_udp,
                    reconnect: form.main_reconnect,
                    record_path: RECORD_PATH,
                    segment: form.main_segment,
                    to_record: form.to_record,
                },
                sub: {
                    sub: form.sub_sub,
                    type: 2,
                    latency: form.sub_latency,
                    use_udp: form.sub_use_udp,
                    reconnect: form.sub_reconnect,
                    record_path: '',
                    segment: 0,
                    to_record: false,
                },
            },
        } as CameraPatchBody['critical'];
    }

    const result = await api.updateCamera(cameraId, body, ownerDevice);
    if ((result as any)?.noop) return { message: 'Изменений нет' };
    return { message: `Камера ${cameraId} обновлена` };
}
