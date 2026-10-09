#pragma once

#include <memory>
#include <mutex>
#include <atomic>
#include <string>
#include <vector>
#include <cstdint>

#include <boost/asio.hpp>

#include "gateway/core/module.h"
#include "gateway/modules/can/bus.h"
#include "gateway/modules/can/codec.h"
#include "gateway/modules/can/traffic-log.h"
#include "gateway/core/config.h"
#include "gateway/core/stats.h"
#include "gateway/core/taxonomy.h"
#include "gateway/core/timesource.h"

namespace varan {
    namespace gateway {

        // Модуль обмена по шине CAN (J1939).
        //
        // Приём: слушает стороннее устройство (Садко, SA 0x61) — координаты
        // (PGN 0xFF00) и дату/время UTC со скоростью (PGN 0xFF01) — и отдаёт их в
        // UTimeSource, откуда время и GPS забирают остальные сервисы.
        //
        // Передача: кадр обнаружений (PGN 0xEF00, SA 0x71) уходит на шину по
        // таймеру раз в tx_period_ms. Сообщение мастера не вызывает отправку, а
        // только обновляет нагрузку — так период на шине ровный и не зависит от
        // частоты работы нейросети.
        //
        // Нагрузка — список обнаружений мастера по ID: «Подтверждён» без картинки добавляет, «Удалён» вычитает
        // Смена сессии мастера очищает список
        // С жизнью нагрузки запись гаснет через payload_ttl_ms после добавления и ждёт «Удалён» погашенной
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
            boost::json::object config_snapshot() const override;
            bool apply_config(const boost::json::object& patch, std::string& err) override;

        private:
            // Обнаружение в нагрузке шины
            struct FDetectionState {
                std::uint64_t id = 0;
                std::string camera;   // camera_id
                int bit = 0;          // 0 — камеры нет в таблице соответствий
                int type = 0;
                int danger = 0;
                std::int64_t mono = 0; // монотонный момент «Подтверждён»
            };

            void start_tx();
            void heartbeat();
            void on_bus_frame(const FCanFrame& frame);
            // Собирает кадр из живых записей и шлёт; only_changed — только если нагрузка изменилась
            void transmit(const FCanConfig& cfg, bool only_changed);

            // Запись входит в нагрузку
            static bool alive(const FDetectionState& d, const FCanConfig& cfg, std::int64_t now);
            FCanDetectionPayload build_payload_locked(const FCanConfig& cfg) const;

            void rebuild_bus_locked();
            FCanConfig config() const;

            std::vector<UCanLog::FSummary> summaries() const;

        private:
            boost::asio::io_context& m_ioc;
            const UTaxonomy& m_taxonomy;
            UTimeSource& m_time;

            mutable std::mutex m_mutex;
            FCanConfig m_config;
            std::shared_ptr<ICanBus> m_bus;

            boost::asio::steady_timer m_tx_timer;
            std::atomic_bool m_active{ false };

            // Момент последнего сердцебиения в лог. Живёт в потоке io_context
            // (таймер передачи), поэтому без атомарности.
            std::int64_t m_last_hb_mono = 0;

            // Список обнаружений. Пишет поток gRPC, читает поток шины.
            mutable std::mutex m_payload_mutex;
            std::vector<FDetectionState> m_detections;
            std::int64_t m_session = 0;               // сессия мастера, по которой ведётся список
            FCanDetectionPayload m_last_payload;      // последняя ушедшая на шину нагрузка
            // Кадры, которым не нашлось камеры в таблице: бит поставить некуда,
            // но обнаружения терять нельзя — считаем и показываем на странице.
            std::atomic<std::int64_t> m_unmapped_cameras{ 0 };
            // Обнаружения из конфигураций без таблицы: числа ушли как есть.
            std::atomic<std::int64_t> m_passthrough_frames{ 0 };

            // Состояние каждого типа сообщения — сводка над лентой.
            mutable std::mutex m_sum_mutex;
            UCanLog::FSummary m_sum_tx;
            UCanLog::FSummary m_sum_gps;
            UCanLog::FSummary m_sum_time;

            std::atomic<std::int64_t> m_rx_other{ 0 };

            UCanLog m_log;
            UStats m_stats;
        };

    } // namespace gateway
} // namespace varan
