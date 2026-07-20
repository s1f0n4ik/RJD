#pragma once

#include <chrono>
#include <cstdint>

namespace varan {
    namespace gateway {

        // Серверное время в миллисекундах Unix. Общая точка для всех, кому нужен
        // момент "сейчас" внутри сервиса.
        inline std::int64_t now_ms() {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
        }

        // Монотонные миллисекунды. Нужны там, где считается длительность: системные
        // часы можно подвести назад (ntp, ручная правка), и разность по ним даст
        // отрицательный или скачущий интервал.
        inline std::int64_t mono_ms() {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
        }

    } // namespace gateway
} // namespace varan
