import { api, type CameraPatchBody } from '../../services/api';
import {
    type Camera,
    type CameraFormData,
    type StreamForm,
    deviceOf,
    formToPayload,
    streamToPayload,
} from './model';

/** Потоки совпадают, если совпадают их ключи и содержимое каждого. */
function streamsChanged(streams: StreamForm[], original: Camera): boolean {
    const before = original.streams ?? {};
    const beforeKeys = Object.keys(before).sort();
    const afterKeys = streams.map(s => s.key).sort();

    if (beforeKeys.length !== afterKeys.length) return true;
    if (beforeKeys.some((key, i) => key !== afterKeys[i])) return true;

    return streams.some(stream => {
        const raw = before[stream.key];
        if (!raw) return true;

        const purposes = [...stream.purposes].sort();
        const rawPurposes = [...(raw.purposes ?? [])].sort();

        return (
            stream.channel !== raw.channel ||
            stream.substream !== raw.substream ||
            stream.latency !== raw.latency ||
            stream.use_udp !== raw.use_udp ||
            stream.reconnect !== raw.reconnect ||
            stream.record_path !== raw.record_path ||
            stream.segment !== raw.segment ||
            purposes.length !== rawPurposes.length ||
            purposes.some((p, i) => p !== rawPurposes[i])
        );
    });
}

/**
 * Сохранение камеры. Для новой — создание на выбранном устройстве. Для
 * существующей — PATCH владельцу, а если оператор выбрал другое устройство,
 * камера переезжает: создаётся на целевом и удаляется у прежнего владельца.
 * PATCH тут не годится — камера принадлежит тому, кто её держит.
 */
export async function saveCamera(
    form: CameraFormData,
    cameraId: string,
    original: Camera | null,
): Promise<{ message: string; warning?: string }> {
    if (!original) {
        await api.createCamera(formToPayload(form, cameraId), form.device_id);
        return { message: `Камера ${cameraId} добавлена` };
    }

    const ownerDevice = deviceOf(original);
    const migrationTarget = form.device_id && form.device_id !== ownerDevice ? form.device_id : null;

    if (migrationTarget) {
        const payload = formToPayload(
            { ...form, password: form.password || original.password },
            cameraId,
        );
        await api.createCamera(payload, migrationTarget);
        try {
            await api.deleteCamera(cameraId, ownerDevice);
            return { message: `Камера ${cameraId} перенесена на другое устройство` };
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
        form.production !== original.production ||
        streamsChanged(form.streams, original);

    if (passwordChanged || criticalChanged) {
        body.critical = {
            ip_adress: form.ip_adress,
            port: form.port,
            user: form.user,
            password: form.password,
            production: form.production,
            streams: Object.fromEntries(form.streams.map(s => [s.key, streamToPayload(s)])),
        } as CameraPatchBody['critical'];
    }

    const result = await api.updateCamera(cameraId, body, ownerDevice);
    if ((result as any)?.noop) return { message: 'Изменений нет' };
    return { message: `Камера ${cameraId} обновлена` };
}
