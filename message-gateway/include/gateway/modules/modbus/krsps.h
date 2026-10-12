#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include <boost/asio.hpp>
#include <boost/json.hpp>

#include "gateway/modules/modbus/module.h"
#include "gateway/modules/modbus/packet.h"
#include "gateway/modules/modbus/queue.h"

namespace varan {
    namespace gateway {

        // Карта регистров протокола АС КРСПС v2.3
        namespace krsps {
            constexpr std::uint16_t SPACE_BEGIN = 0x1000;     // Input и Holding: 0x1000–0x2FFF
            constexpr std::uint16_t SPACE_END = 0x3000;
            constexpr std::uint16_t STATE_BLOCK = 0x1000;     // Input: 0x1000–0x1006, затем регистры состояния
            constexpr std::uint16_t STATE_FIXED = 7;
            constexpr std::uint16_t RECORDS = 0x2000;         // Input: окно записей
            constexpr std::uint16_t COMMAND = 0x1000;         // Holding: команда, 0x1001–0x1002 — параметры
            constexpr std::uint16_t COMMAND_REGS = 3;         // значение 0x1004
            constexpr std::uint16_t MASTER_GPS = 0x2000;      // Holding: 8 регистров координат
            constexpr std::uint16_t MASTER_TIME = 0x2008;     // Holding: 4 регистра времени, младшие первыми
            constexpr std::uint16_t SETTINGS = 0x8000;        // Holding: настройки порта 0x8000–0x8008
            constexpr std::uint16_t SETTINGS_COUNT = 9;
            constexpr std::uint16_t CMD_NONE = 0x0000;
            constexpr std::uint16_t CMD_MARK = 0x0001;
        }

        // Регистр состояния 0x1007 и дальше
        struct FStateRegister {
            std::uint16_t value = 0;
            std::string label;
            bool ok = false;
            std::string code;                   // причина для стенда и логов
            std::vector<std::string> reason;    // причина по частям для страницы
            std::string error;
        };

        // Координаты из 8 регистров 0x2000–0x2007; полушария — по буквам в любом из двух последних
        bool decode_master_gps(const std::uint16_t* regs, double& lat, double& lon);
        // Время из 4 регистров 0x2008–0x200B, unix секунды UTC; false — вне 2025–2050
        bool decode_master_time(const std::uint16_t* regs, std::int64_t& unix_s);

        // Протокол АС КРСПС v2.3 поверх ведомого RTU: блок состояния, окно записей, отметка, время и GPS ведущего
        // Записи до первого времени от ведущего скрыты, затем сдвигаются на разницу его времени и часов платы
        class AKrspsModule : public AModbusModule {
        public:
            AKrspsModule(boost::asio::io_context& ioc, FModbusConfig config, std::string queue_file);

        protected:
            // Пакеты конфигурации
            virtual std::vector<const AModbusPacket*> packets() const = 0;
            // Регистры 0x1007 и дальше, минимум один
            virtual std::vector<FStateRegister> state_registers() const = 0;
            // Команды кроме 0x0000 и 0x0001; код исключения
            virtual std::uint8_t on_command(std::uint16_t cmd, FExchange& ex);
            // Настройки порта 0x8000–0x8008; код исключения
            virtual std::uint8_t on_settings(std::uint16_t start, const std::uint16_t* values, std::uint16_t count,
                FExchange& ex);
            // Время и координаты ведущего после разбора
            virtual void on_master_time(std::int64_t unix_s) {}
            virtual void on_master_gps(double lat, double lon) {}

            // Запись в очередь; utc_ms = 0 — текущее время ведущего или платы
            FModbusRecord enqueue(const AModbusPacket& packet, std::vector<std::uint16_t> regs, std::int64_t utc_ms = 0);
            // Holding-регистр 0x1000–0x2FFF, только в потоке io_context
            std::uint16_t holding(std::uint16_t reg) const;

            std::uint8_t read_input(std::uint16_t start, std::uint16_t count, std::uint16_t* values,
                FExchange& ex) override;
            std::uint8_t write_holding(std::uint16_t start, const std::uint16_t* values, std::uint16_t count,
                FExchange& ex) override;
            void status(boost::json::object& m) const override;

        private:
            // Значение 0x1002: длина, если она одна у всех пакетов конфигурации и всех записей очереди, иначе 0
            std::uint16_t record_length() const;
            const AModbusPacket* find_packet(std::uint16_t kind) const;
            boost::json::object record_json(const FModbusRecord& r) const;
            void mark(FExchange& ex);
            void master_gps(FExchange& ex);
            void master_time(FExchange& ex);

        private:
            // Только в потоке io_context
            std::array<std::uint16_t, krsps::SPACE_END - krsps::SPACE_BEGIN> m_holding{};

            UModbusQueue m_queue;
            // Проверка «скрыта ли запись» и первое время ведущего — под одним замком
            std::mutex m_sync_mutex;
            std::atomic_bool m_synced{ false };
            std::atomic<std::int64_t> m_sync_offset_ms{ 0 };

            // Последнее от ведущего для страницы
            mutable std::mutex m_info_mutex;
            std::int64_t m_time_s = 0;
            std::int64_t m_time_mono = 0;
            double m_lat = 0.0;
            double m_lon = 0.0;
            std::int64_t m_gps_mono = 0;
            boost::json::object m_last_mark;

            std::atomic<std::int64_t> m_marks_ok{ 0 };
            std::atomic<std::int64_t> m_marks_rejected{ 0 };
            std::atomic<std::int64_t> m_time_updates{ 0 };
            std::atomic<std::int64_t> m_time_invalid{ 0 };
            std::atomic<std::int64_t> m_gps_invalid{ 0 };
        };

    } // namespace gateway
} // namespace varan
