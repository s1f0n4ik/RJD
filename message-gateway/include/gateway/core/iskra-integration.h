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

        // Пакет 28163 — запись обнаружения Искры, 32 регистра
        // 0 длина, 1 номер, 2 тип, 3–6 время, 7–9 широта, 10–12 долгота, 13 E/W, 14 N/S, 15 код, 16–17 стоп-кадр, 18 маска, 19 зона, 20 число
        class UIskraPacket28163 : public AModbusPacket {
        public:
            std::uint16_t kind() const override { return 28163; }
            std::uint16_t length() const override { return 32; }
            void stamp(std::vector<std::uint16_t>& regs, std::int64_t utc_ms) const override;
            std::vector<FPacketField> describe(const std::vector<std::uint16_t>& regs) const override;

            // Запись из полей мастера; номер и время ставит очередь
            std::vector<std::uint16_t> build(const FRecord& rec) const;
        };

        // Modbus Искры: записи 28163 из сообщений мастера, регистр 0x1007 по техзрению, время и GPS ведущего в UTimeSource
        class UIskraModbusModule : public AKrspsModule {
        public:
            UIskraModbusModule(boost::asio::io_context& ioc, FModbusConfig config, UTimeSource& time_source,
                std::string queue_file);

            // В очередь идут только сообщения с записью
            FSubmitResult handle_frame(const FFrameMessage& msg) override;

            // Регистр 0x1007 и причина от опроса техзрения
            void set_state(std::uint16_t value, boost::json::object reason);

        protected:
            std::vector<const AModbusPacket*> packets() const override { return { &m_packet }; }
            std::vector<FStateRegister> state_registers() const override;
            void on_master_time(std::int64_t unix_s) override;
            void on_master_gps(double lat, double lon) override;

        private:
            UTimeSource& m_time;
            UIskraPacket28163 m_packet;

            mutable std::mutex m_state_mutex;
            std::uint16_t m_state_value = 0;
            boost::json::object m_state_reason;
        };

        // Интеграция Искры: записи обнаружений в АС КРСПС по Modbus RTU, время и GPS от АС КРСПС
        // Регистр состояния 0x1007 — по /api/neural/status бэкенда раз в STATE_POLL_SEC
        class UIskraIntegration : public IIntegration {
        public:
            static constexpr int STATE_POLL_SEC = 5;

            UIskraIntegration(boost::asio::io_context& ioc, FModbusConfig modbus, UTimeSource& time_source,
                std::string queue_file, std::string backend_url);
            ~UIskraIntegration() override;

            std::string id() const override { return "iskra"; }
            std::string title() const override { return "Искра"; }
            std::string description() const override {
                return "Передача записей обнаружений в АС КРСПС по Modbus RTU (пакет 28163), "
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

            // 1 — все слоты техзрения плат запущены и все плитки камер ok; reason — код причины для страницы
            static std::uint16_t evaluate(const boost::json::value& body, boost::json::object& reason);

        private:
            void poll_loop();
            void stop_poller();

        private:
            std::shared_ptr<UIskraModbusModule> m_modbus;
            std::string m_backend_url;

            std::mutex m_poll_mutex;
            std::condition_variable m_poll_cv;
            bool m_polling = false;
            std::thread m_poller;
        };

    } // namespace gateway
} // namespace varan
