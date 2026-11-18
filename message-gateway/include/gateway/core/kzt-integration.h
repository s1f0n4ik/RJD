#pragma once

#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <boost/asio.hpp>
#include <boost/json.hpp>

#include "gateway/core/config.h"
#include "gateway/core/integration.h"
#include "gateway/core/timesource.h"
#include "gateway/modules/modbus/krsps.h"

namespace varan {
    namespace gateway {

        // Пакет 1 — состав КЖТ, 32 регистра
        // 0 длина, 1 номер, 2 тип, 3–6 время, 7–9 широта, 10–12 долгота, 13 E/W, 14 N/S,
        // 15–17 коды навесного, 18–20 число грузов трёх слотов, 21 флаг работы
        class UKztPacket : public AModbusPacket {
        public:
            std::uint16_t kind() const override { return 1; }
            std::uint16_t length() const override { return 32; }
            void stamp(std::vector<std::uint16_t>& regs, std::int64_t utc_ms) const override;
            std::vector<FPacketField> describe(const std::vector<std::uint16_t>& regs) const override;

            // Запись состава; номер и время ставит очередь
            std::vector<std::uint16_t> build(const FKztState& state, bool working, const FTimeGpsSnapshot& gps) const;
        };

        // Modbus КЖТ: пакет при смене состава и повтор последнего раз в период,
        // флаг работы с выдержкой на падение, время и GPS ведущего в UTimeSource
        class UKztModbusModule : public AKrspsModule {
        public:
            static constexpr int DEFAULT_PERIOD_S = 60;
            static constexpr std::int64_t WORK_HOLD_MS = 300000;

            UKztModbusModule(boost::asio::io_context& ioc, FModbusConfig config, UTimeSource& time_source,
                std::string queue_file);

            // В очередь идут только сообщения с составом, отличным от последнего
            FSubmitResult handle_frame(const FFrameMessage& msg) override;

            // Состояние техзрения по опросу; в 0 флаг падает после WORK_HOLD_MS непрерывного сбоя
            void set_state(std::uint16_t value, boost::json::object reason);
            // Повтор последнего состава, если период истёк
            void tick();
            // Камера флага работы из последнего состава; пусто — все камеры
            std::string camera_id() const;

        protected:
            std::vector<const AModbusPacket*> packets() const override { return { &m_packet }; }
            std::vector<FStateRegister> state_registers() const override;
            std::int64_t on_master_time(std::int64_t unix_s) override;
            void on_master_gps(double lat, double lon) override;

        private:
            // Под m_state_mutex
            void send(const char* why);

        private:
            UTimeSource& m_time;
            UKztPacket m_packet;

            mutable std::mutex m_state_mutex;
            FKztState m_state;
            std::string m_camera_id;
            std::int64_t m_sent_mono = 0;
            std::uint16_t m_working = 1;
            std::int64_t m_fail_since = 0;
            boost::json::object m_reason;
        };

        // Интеграция КЖТ: состав навесного и грузов в АС КРСПС по Modbus RTU, время и GPS от АС КРСПС
        // Флаг работы — по /api/neural/status бэкенда для камеры КЖТ раз в STATE_POLL_SEC
        class UKztIntegration : public IIntegration {
        public:
            static constexpr int STATE_POLL_SEC = 5;

            UKztIntegration(boost::asio::io_context& ioc, FModbusConfig modbus, UTimeSource& time_source,
                std::string queue_file, std::string backend_url);
            ~UKztIntegration() override;

            std::string id() const override { return "kzt"; }
            std::string title() const override { return "КЖТ"; }
            std::string description() const override {
                return "Передача состава навесного оборудования и грузов в АС КРСПС по Modbus RTU (пакет 1), "
                    "синхронизация времени и GPS от АС КРСПС.";
            }

            std::vector<std::shared_ptr<IModule>> modules() const override { return { m_modbus }; }
            std::shared_ptr<IModule> find_module(const std::string& id) const override;

            void start() override;
            void stop() override;
            bool connected() const override;

            FSubmitResult handle_frame(const FFrameMessage& msg) override;
            std::vector<int> protocol_versions() const override { return {}; }

            boost::json::object config_json() const override;
            boost::json::object status_json() const override;

        private:
            void poll_loop();
            void stop_poller();

        private:
            std::shared_ptr<UKztModbusModule> m_modbus;
            std::string m_backend_url;

            std::mutex m_poll_mutex;
            std::condition_variable m_poll_cv;
            bool m_polling = false;
            std::thread m_poller;
        };

    } // namespace gateway
} // namespace varan
