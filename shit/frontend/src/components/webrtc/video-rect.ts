/**
 * Прямоугольник реального кадра внутри элемента video.
 *
 * При object-fit: contain кадр не занимает элемент целиком — по краям поля.
 * Слои поверх видео (рамки обнаружений, жесты 360) должны совпадать именно
 * с кадром, иначе координаты уезжают на ширину полей.
 */
export function getVideoContentRect(video: HTMLVideoElement): DOMRect | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const elem = video.getBoundingClientRect();
    if (!elem.width || !elem.height) return null;

    const videoAspect = vw / vh;
    const containerAspect = elem.width / elem.height;

    let contentW: number;
    let contentH: number;
    if (videoAspect > containerAspect) {
        contentW = elem.width;
        contentH = elem.width / videoAspect;
    } else {
        contentH = elem.height;
        contentW = elem.height * videoAspect;
    }

    return new DOMRect(
        (elem.width - contentW) / 2,
        (elem.height - contentH) / 2,
        contentW,
        contentH,
    );
}
