#pragma once

#include <string>
#include <array>
#include <functional>
#include <memory>
#include <mutex>
#include <atomic>
#include <cstdint>

#include <boost/asio.hpp>

#include "gateway/config.h"

namespace varan {
    namespace gateway {

        // Один кадр шины. Держим ровно то, что есть в CAN 2.0: идентификатор,
        // признак расширенного (29-битного) id и до 8 байт данных. Всё, что выше
        // (J1939, PGN, раскладка байт) — забота кодека, шина про это не знает.
        struct FCanFrame {
            std::uint32_t id = 0;
            bool extended = true;
            std::uint8_t dlc = 0;
            std::array<std::uint8_t, 8> data{};
        };

        using CCanFrameHandler = std::function<void(const FCanFrame&)>;

        // Контракт шины. Две реализации: SocketCAN (штатный путь Linux, интерфейс
        // can0) и slcan (USB-адаптер прямо на serial port по ASCII-протоколу
        // Lawicel). Модуль CAN работает через этот интерфейс и не знает, какой из
        // них включён.
        class ICanBus {
        public:
            virtual ~ICanBus() = default;

            virtual std::string name() const = 0;
            virtual bool connected() const = 0;

            // Читаемое описание канала для страницы: "can0" / "/dev/ttyUSB0 @ 250000".
            virtual std::string describe() const = 0;

            virtual void open() = 0;
            virtual void close() = 0;
            virtual bool send(const FCanFrame& frame) = 0;

            // Ставится один раз до open(): вызывается на каждый принятый кадр
            // в потоке io_context шины.
            virtual void set_frame_handler(CCanFrameHandler handler) = 0;

            // Текст последней ошибки открытия/чтения — его показывает страница,
            // иначе "нет связи" без причины и непонятно, куда смотреть.
            virtual std::string last_error() const = 0;
        };

        // Общая часть обеих шин: хранение обработчика, бесконечное переподключение
        // и учёт последней ошибки. Наследник реализует только сам ввод-вывод.
        //
        // enable_shared_from_this обязателен: шину пересоздают на ходу (смена
        // режима или устройства через REST), и старый объект уничтожается, пока
        // на io_context ещё висят его чтение и таймер переподключения. Поэтому
        // все асинхронные операции держат shared_ptr на себя и продлевают жизнь
        // объекта до своего вызова.
        class ACanBus : public ICanBus, public std::enable_shared_from_this<ACanBus> {
        public:
            explicit ACanBus(boost::asio::io_context& ioc, int retry_sec = 5)
                : m_ioc(ioc)
                , m_retry_timer(ioc)
                , m_retry_sec(retry_sec)
            {}

            void set_frame_handler(CCanFrameHandler handler) override {
                m_handler = std::move(handler);
            }

            bool connected() const override {
                return m_connected.load();
            }

            std::string last_error() const override {
                std::lock_guard<std::mutex> lock(m_err_mutex);
                return m_last_error;
            }

            void open() override {
                m_enabled = true;
                boost::asio::post(m_ioc, [self = shared_from_this()] { self->try_open(); });
            }

            void close() override {
                m_enabled = false;
                boost::asio::post(m_ioc, [self = shared_from_this()] {
                    self->m_retry_timer.cancel();
                    self->do_close();
                    self->m_connected = false;
                });
            }

        protected:
            // Реализация наследника: открыть канал и запустить чтение. false +
            // текст ошибки, если не вышло — база сама перепланирует попытку.
            virtual bool do_open(std::string& err) = 0;
            virtual void do_close() = 0;

            void set_error(const std::string& err) {
                std::lock_guard<std::mutex> lock(m_err_mutex);
                m_last_error = err;
            }

            void deliver(const FCanFrame& frame) {
                if (m_handler) {
                    m_handler(frame);
                }
            }

            // Наследник зовёт при обрыве чтения: канал закрывается и уходит в
            // переподключение, если модуль всё ещё включён.
            void on_failure(const std::string& err) {
                if (!m_connected.exchange(false)) {
                    return;
                }
                set_error(err);
                do_close();
                schedule_retry();
            }

            void try_open() {
                if (!m_enabled.load() || m_connected.load()) {
                    return;
                }
                std::string err;
                if (do_open(err)) {
                    m_connected = true;
                    set_error("");
                    return;
                }
                set_error(err);
                schedule_retry();
            }

        private:
            void schedule_retry() {
                if (!m_enabled.load()) {
                    return;
                }
                m_retry_timer.expires_after(std::chrono::seconds(m_retry_sec));
                m_retry_timer.async_wait([self = shared_from_this()](const boost::system::error_code& ec) {
                    if (!ec) {
                        self->try_open();
                    }
                });
            }

        protected:
            boost::asio::io_context& m_ioc;
            CCanFrameHandler m_handler;
            std::atomic_bool m_connected{ false };
            std::atomic_bool m_enabled{ false };

        private:
            boost::asio::steady_timer m_retry_timer;
            int m_retry_sec;
            mutable std::mutex m_err_mutex;
            std::string m_last_error;
        };

        // Штатный путь под Linux: raw-сокет SocketCAN на интерфейсе can0/vcan0.
        // Скорость шины задаётся снаружи (ip link set can0 up type can bitrate ...),
        // сокет её не выставляет.
        class USocketCanBus : public ACanBus {
        public:
            USocketCanBus(boost::asio::io_context& ioc, std::string iface);
            ~USocketCanBus() override;

            std::string name() const override { return "socketcan"; }
            std::string describe() const override { return m_iface; }

            bool send(const FCanFrame& frame) override;

        protected:
            bool do_open(std::string& err) override;
            void do_close() override;

        private:
            void start_read();

        private:
            std::string m_iface;
            std::mutex m_mutex;
            // Сокет заворачивается в stream_descriptor, чтобы читать асинхронно на
            // общем io_context, а не отдельным потоком с блокирующим read.
            std::unique_ptr<boost::asio::posix::stream_descriptor> m_sd;
            std::array<std::uint8_t, 16> m_rx{};  // sizeof(struct can_frame)
        };

        // USB-адаптер напрямую на serial port: ASCII-протокол Lawicel (slcan).
        // Нужен там, где нет slcand и поднимать сетевой интерфейс нечем.
        class USlcanBus : public ACanBus {
        public:
            USlcanBus(boost::asio::io_context& ioc, std::string device, int bitrate);
            ~USlcanBus() override;

            std::string name() const override { return "slcan"; }
            std::string describe() const override {
                return m_device + " @ " + std::to_string(m_bitrate);
            }

            bool send(const FCanFrame& frame) override;

        protected:
            bool do_open(std::string& err) override;
            void do_close() override;

        private:
            void start_read();
            void handle_line(const std::string& line);
            bool write_command(const std::string& cmd, std::string& err);

            // Скорость шины в slcan задаётся индексом S0..S8, произвольное число
            // адаптер не примет.
            static bool bitrate_index(int bitrate, char& out);

        private:
            std::string m_device;
            int m_bitrate;
            std::mutex m_mutex;
            std::unique_ptr<boost::asio::serial_port> m_port;
            boost::asio::streambuf m_buf;
        };

        // Собирает шину под выбранный режим конфигурации.
        std::shared_ptr<ICanBus> make_can_bus(boost::asio::io_context& ioc, const FCanConfig& config);

    } // namespace gateway
} // namespace varan
