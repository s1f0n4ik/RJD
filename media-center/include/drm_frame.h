#include <unistd.h> // close, dup

namespace varan {
namespace neural {

 /**
 * @brief Структура, представляющая кадр с использованием DRM PRIME буфера.
 *
 * Поля:
 * @param fd        Файловый дескриптор DMABUF, который содержит изображение.
 * @param width     Ширина кадра в пикселях.
 * @param height    Высота кадра в пикселях.
 * @param format    Формат изображения (например, DRM fourcc код).
 * @param offset    Смещения для каждой плоскости в байтах.
 * @param pitch     Ширина (stride) каждой плоскости в байтах.
 * @param num_planes Количество плоскостей изображения (например, 2 для NV12).
 * @param pts_ms    Таймстамп кадра в миллисекундах.
 */
struct FDrmFrame {	
	int fd;
	int width;
	int height;
    int format;
    int offset[4];
    int pitch[4];
    int num_planes;
	int64_t pts_ms;

    FDrmFrame() = default;
    FDrmFrame(
        int fd_ = -1,
        int w = 0, 
        int h = 0, 
        int format_ = -1,
        const int offset_[4] = nullptr,
        const int pitch_[4] = nullptr,
        int num_planes_ = 0,
        int64_t pts = 0
    ) 
        : fd(fd_)
        , width(w)
        , height(h)
        , format(format_)
        , num_planes(num_planes_)
        , pts_ms(pts) 
    {
        if (offset_) {
            for (int i = 0; i < 4; i++) offset[i] = offset_[i];
        }
        else {
            for (int i = 0; i < 4; i++) offset[i] = 0;
        }

        if (pitch_) {
            for (int i = 0; i < 4; i++) pitch[i] = pitch_[i];
        }
        else {
            for (int i = 0; i < 4; i++) pitch[i] = 0;
        }
    }


    FDrmFrame(FDrmFrame&& other) noexcept {
        fd = other.fd;
        width = other.width;
        height = other.height;
        pts_ms = other.pts_ms;
        format = other.format;
        num_planes = other.num_planes;

        for (int i = 0; i < 4; i++) {
            offset[i] = other.offset[i];
            pitch[i] = other.pitch[i];
        }

        // инвалидируем другой объект
        other.fd = -1;
        other.width = 0;
        other.height = 0;
        other.pts_ms = 0;
        other.format = -1;
        other.num_planes = 0;

        for (int i = 0; i < 4; i++) {
            other.offset[i] = 0;
            other.pitch[i] = 0;
        }
    }

    FDrmFrame& operator=(FDrmFrame&& other) noexcept
    {
        if (this != &other)
        {
            // если у текущего объекта есть fd — нужно закрыть
            if (fd >= 0) {
                close(fd);
            }

            fd = other.fd;
            width = other.width;
            height = other.height;
            format = other.format;
            pts_ms = other.pts_ms;
            num_planes = other.num_planes;

            for (int i = 0; i < 4; i++) {
                offset[i] = other.offset[i];
                pitch[i] = other.pitch[i];
            }

            other.fd = -1;
            other.width = 0;
            other.height = 0;
            other.format = -1;
            other.pts_ms = 0;
            other.num_planes = 0;
            for (int i = 0; i < 4; i++) {
                other.offset[i] = 0;
                other.pitch[i] = 0;
            }
        }
        return *this;
    }

    ~FDrmFrame() {
        if (fd >= 0) {
            close(fd);
        }
    }

    // Убираем возможность копирования
    FDrmFrame(const FDrmFrame&) = delete;
    FDrmFrame& operator=(const FDrmFrame&) = delete;

};

} // neural
} // varan