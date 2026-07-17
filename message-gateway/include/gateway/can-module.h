#pragma once

#include <memory>
#include <mutex>
#include <atomic>
#include <string>
#include <cstdint>

#include <boost/asio.hpp>

#include "gateway/module.h"
#include "gateway/can-bus.h"
#include "gateway/can-codec.h"
#include "gateway/config.h"
#include "gateway/stats.h"
#include "gateway/taxonomy.h"
#include "gateway/timesource.h"

namespace varan {
    namespace gateway {

        // Модуль обмена по шине CAN (J1939).
        //
        // Приём: слушает стороннее устройство (Садко, SA 0x61) — координаты
        // (PGN 0xFF00) и дату/время UTC со скоростью (PGN 0xFF01) — и отдаёт их в
        // UTimeSource, откуда время и GPS забирают остальные сервисы.
        //
        // Передача: кадр обнаружений (PGN 0xEF00, SA 0x71) уходит на шину строго по
        // таймеру раз в tx_period_ms, независимо от gRPC. Кадр от media-center не
        // вызывает отправку, а только обновляет нагрузку — так период на шине
        // остаётся ровным и не зависит от частоты работы нейросети.
        class UCanModule : public IModule {
        public:
            UCanModule(boost::asio::io_context& ioc, FCanConfig config,
                const UTaxonomy& taxonomy, UTimeSource& time_source);

            std::string id() const override { return "can"; }
            std::string title() const override { return "CAN"; }
            std::string transport() const override { return "can"; }

            void start() override;
            void stop() override;
            bool connected() const override;

            FSubmitResult handle_frame(const FFrameMessage& msg) override;

            // CAN несёт только числовые id из общей таблицы, версия протокола
            // изображения к нему не относится: кодек здесь свой и один.
            std::vector<int> protocol_versions() const override { return {}; }

            boost::json::object to_json() const override;
            bool apply_config(const boost::json::object& patch, std::string& err) override;

        private:
            void start_tx();
            void on_bus_frame(const FCanFrame& frame);

            // Пересобирает шину под текущий режим и поднимает её, если модуль включён.
            void rebuild_bus_locked();

            FCanConfig config() const;

        private:
            boost::asio::io_context& m_ioc;
            const UTaxonomy& m_taxonomy;
            UTimeSource& m_time;

            mutable std::mutex m_mutex;
            FCanConfig m_config;
            std::shared_ptr<ICanBus> m_bus;

            boost::asio::steady_timer m_tx_timer;
            std::atomic_bool m_active{ false };

            // Текущая нагрузка исходящего кадра — то, что уйдёт на шину следующим
            // тиком. Обновляется из gRPC-потока, читается из потока шины.
            mutable std::mutex m_payload_mutex;
            FCanDetectionPayload m_payload;
            std::int64_t m_payload_mono = 0;   // монотонный момент последнего кадра gRPC

            // Кадр gRPC, который ещё не уходил на шину. Кладём его в ленту только
            // после реальной отправки: CAN отдаёт лишь последнюю нагрузку, и кадр,
            // вытесненный следующим за 100 мс, на шину не попадал.
            bool m_pending = false;
            std::int64_t m_pending_id = 0;
            std::int64_t m_pending_ts = 0;
            int m_pending_dets = 0;
            bool m_pending_image = false;

            // Что слышно от Садко — показывается на странице, чтобы было видно,
            // жива ли встречная сторона.
            std::atomic<std::int64_t> m_rx_gps{ 0 };
            std::atomic<std::int64_t> m_rx_time{ 0 };
            std::atomic<std::int64_t> m_rx_errors{ 0 };
            std::atomic<std::int64_t> m_rx_other{ 0 };
            mutable std::mutex m_rx_mutex;
            std::string m_rx_last_error;

            UStats m_stats;
        };

    } // namespace gateway
} // namespace varan
