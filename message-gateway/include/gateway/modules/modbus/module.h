#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <boost/asio.hpp>
#include <boost/json.hpp>

#include "gateway/core/config.h"
#include "gateway/core/module.h"
#include "gateway/core/stats.h"
#include "gateway/modules/modbus/rtu.h"

namespace varan {
    namespace gateway {

        // Ведомый Modbus RTU на serial port: кадры, CRC, функции 0x04, 0x06, 0x10, исключения, лента обмена
        // Содержимое регистров задаёт наследник через read_input и write_holding
        class AModbusModule : public IModule {
        public:
            // Ведущий молчит дольше — не на связи
            static constexpr std::int64_t MASTER_SILENCE_MS = 15000;

            AModbusModule(boost::asio::io_context& ioc, FModbusConfig config);

            std::string id() const override { return "modbus"; }
            std::string title() const override { return "Modbus"; }
            std::string transport() const override { return "modbus"; }

            void start() override;
            void stop() override;
            bool connected() const override;

            std::vector<int> protocol_versions() const override { return {}; }

            boost::json::object to_json() const override;
            boost::json::object config_snapshot() const override;
            bool apply_config(const boost::json::object& patch, std::string& err) override;

        protected:
            // Обмен с ведущим: запрос и наш ответ
            struct FExchange {
                std::int64_t seq = 0;
                std::int64_t ts = 0;
                int address = 0;
                int function = 0;
                int reg = 0;
                int count = 0;
                int exception = 0;
                std::string kind;
                std::string rx;
                std::string tx;
                boost::json::object detail;
            };

            // Код исключения, 0 — values заполнены; values приходят нулями
            virtual std::uint8_t read_input(std::uint16_t start, std::uint16_t count, std::uint16_t* values,
                FExchange& ex) = 0;
            // Код исключения, 0 — запись принята
            virtual std::uint8_t write_holding(std::uint16_t start, const std::uint16_t* values, std::uint16_t count,
                FExchange& ex) = 0;
            // Поля статуса поверх ядра
            virtual void status(boost::json::object& m) const = 0;

            FModbusConfig config() const;

            UStats m_stats;

        private:
            // Порт и разбор — только в потоке io_context
            void try_open();
            void close_port();
            void schedule_retry();
            void on_failure(const std::string& err);
            void start_read(unsigned gen);
            void arm_gap();
            void parse();
            void drop(std::size_t n);
            void log_junk();
            void flush_garbage();
            void housekeeping();

            void on_request(const std::uint8_t* frame, std::size_t n);

            void log_exchange(FExchange ex);
            void set_error(const std::string& err);
            std::string error() const;

        private:
            boost::asio::io_context& m_ioc;

            mutable std::mutex m_mutex;
            FModbusConfig m_config;

            std::atomic_bool m_active{ false };
            std::atomic_bool m_connected{ false };
            std::atomic_bool m_waiting{ false };
            std::atomic_int m_attempt{ 0 };
            std::atomic<std::int64_t> m_next_retry_mono{ 0 };
            mutable std::mutex m_err_mutex;
            std::string m_error;

            std::unique_ptr<boost::asio::serial_port> m_port;
            unsigned m_gen = 0;
            std::array<std::uint8_t, 512> m_chunk{};
            std::vector<std::uint8_t> m_buf;
            // Отброшенные байты до следующего кадра — одной строкой в лог
            std::vector<std::uint8_t> m_junk;
            // Буфер начинается с границы кадра
            bool m_aligned = true;
            // Адрес чужого ведомого, чей ответ ждём следом, -1 — не ждём
            int m_expect = -1;
            bool m_master_online = false;
            boost::asio::steady_timer m_retry_timer;
            boost::asio::steady_timer m_gap_timer;
            boost::asio::steady_timer m_housekeeping_timer;

            std::atomic<std::int64_t> m_last_master_mono{ 0 };

            std::atomic<std::int64_t> m_requests{ 0 };
            std::atomic<std::int64_t> m_broadcasts{ 0 };
            std::atomic<std::int64_t> m_exceptions{ 0 };
            std::atomic<std::int64_t> m_crc_errors{ 0 };
            std::atomic<std::int64_t> m_garbage{ 0 };
            std::atomic<std::int64_t> m_foreign{ 0 };
            std::atomic<int> m_foreign_last{ 0 };

            mutable std::mutex m_log_mutex;
            std::deque<FExchange> m_log;
            std::int64_t m_seq = 0;
        };

    } // namespace gateway
} // namespace varan
