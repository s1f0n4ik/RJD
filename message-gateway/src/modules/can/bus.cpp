#include "gateway/modules/can/bus.h"
#include "gateway/utility/log.h"

#include <cstring>
#include <cstdio>
#include <istream>

#if defined(__linux__)
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <net/if.h>
#include <unistd.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#endif

namespace varan {
    namespace gateway {

        namespace {
            const char* TAG_SOCK = "can:socketcan";
            const char* TAG_SLCAN = "can:slcan";
        }

        // ---------------------------------------------------------------- SocketCAN

        USocketCanBus::USocketCanBus(boost::asio::io_context& ioc, std::string iface)
            : ACanBus(ioc)
            , m_iface(std::move(iface))
        {}

        USocketCanBus::~USocketCanBus() {
            do_close();
        }

#if defined(__linux__)

        bool USocketCanBus::do_open(std::string& err) {
            std::lock_guard<std::mutex> lock(m_mutex);

            const int fd = ::socket(PF_CAN, SOCK_RAW, CAN_RAW);
            if (fd < 0) {
                err = std::string("socket(PF_CAN): ") + std::strerror(errno);
                return false;
            }

            ifreq ifr{};
            std::snprintf(ifr.ifr_name, IFNAMSIZ, "%s", m_iface.c_str());
            if (::ioctl(fd, SIOCGIFINDEX, &ifr) < 0) {
                err = "interface '" + m_iface + "' not found: " + std::strerror(errno);
                ::close(fd);
                return false;
            }

            sockaddr_can addr{};
            addr.can_family = AF_CAN;
            addr.can_ifindex = ifr.ifr_ifindex;
            if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
                err = "bind " + m_iface + ": " + std::strerror(errno);
                ::close(fd);
                return false;
            }

            m_sd = std::make_unique<boost::asio::posix::stream_descriptor>(m_ioc, fd);
            ULog::info(TAG_SOCK, "Opened " + m_iface);

            start_read();
            return true;
        }

        void USocketCanBus::start_read() {
            if (!m_sd) {
                return;
            }
            m_sd->async_read_some(boost::asio::buffer(m_rx),
                [this, self = shared_from_this()](const boost::system::error_code& ec, std::size_t n) {
                    if (ec) {
                        if (ec != boost::asio::error::operation_aborted) {
                            on_failure("read: " + ec.message());
                        }
                        return;
                    }
                    if (n >= sizeof(can_frame)) {
                        can_frame raw{};
                        std::memcpy(&raw, m_rx.data(), sizeof(raw));

                        // Кадры ошибок шины данными не являются: пропускаем, иначе
                        // они разберутся кодеком как мусорное сообщение.
                        if ((raw.can_id & CAN_ERR_FLAG) == 0) {
                            FCanFrame f;
                            f.extended = (raw.can_id & CAN_EFF_FLAG) != 0;
                            f.id = raw.can_id & (f.extended ? CAN_EFF_MASK : CAN_SFF_MASK);
                            f.dlc = raw.can_dlc > 8 ? 8 : raw.can_dlc;
                            std::memcpy(f.data.data(), raw.data, f.dlc);
                            deliver(f);
                        }
                    }
                    std::lock_guard<std::mutex> lock(m_mutex);
                    start_read();
                });
        }

        bool USocketCanBus::send(const FCanFrame& frame) {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (!m_sd || !m_connected.load()) {
                return false;
            }

            can_frame raw{};
            raw.can_id = frame.id;
            if (frame.extended) {
                raw.can_id |= CAN_EFF_FLAG;
            }
            raw.can_dlc = frame.dlc;
            std::memcpy(raw.data, frame.data.data(), frame.dlc);

            boost::system::error_code ec;
            boost::asio::write(*m_sd, boost::asio::buffer(&raw, sizeof(raw)), ec);
            if (ec) {
                set_error("write: " + ec.message());
                return false;
            }
            return true;
        }

        void USocketCanBus::do_close() {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_sd) {
                boost::system::error_code ec;
                m_sd->close(ec);
                m_sd.reset();
            }
        }

#else

        // SocketCAN есть только в Linux. На других платформах сервис собирается
        // (для intellisense/локальной сборки), но режим socketcan честно не
        // поднимается — вместо тихой заглушки отдаём внятную ошибку.
        bool USocketCanBus::do_open(std::string& err) {
            err = "socketcan is available on Linux only; use slcan mode";
            return false;
        }

        void USocketCanBus::start_read() {}

        bool USocketCanBus::send(const FCanFrame&) {
            return false;
        }

        void USocketCanBus::do_close() {}

#endif

        // --------------------------------------------------------------------- slcan

        USlcanBus::USlcanBus(boost::asio::io_context& ioc, std::string device, int bitrate)
            : ACanBus(ioc)
            , m_device(std::move(device))
            , m_bitrate(bitrate)
        {}

        USlcanBus::~USlcanBus() {
            do_close();
        }

        bool USlcanBus::bitrate_index(int bitrate, char& out) {
            switch (bitrate) {
            case 10000:   out = '0'; return true;
            case 20000:   out = '1'; return true;
            case 50000:   out = '2'; return true;
            case 100000:  out = '3'; return true;
            case 125000:  out = '4'; return true;
            case 250000:  out = '5'; return true;
            case 500000:  out = '6'; return true;
            case 800000:  out = '7'; return true;
            case 1000000: out = '8'; return true;
            default: return false;
            }
        }

        bool USlcanBus::write_command(const std::string& cmd, std::string& err) {
            boost::system::error_code ec;
            boost::asio::write(*m_port, boost::asio::buffer(cmd), ec);
            if (ec) {
                err = "write '" + cmd.substr(0, cmd.size() - 1) + "': " + ec.message();
                return false;
            }
            return true;
        }

        bool USlcanBus::do_open(std::string& err) {
            std::lock_guard<std::mutex> lock(m_mutex);

            char index = '5';
            if (!bitrate_index(m_bitrate, index)) {
                err = "unsupported bitrate " + std::to_string(m_bitrate) +
                    "; supported: 10000..1000000 (slcan S0..S8)";
                return false;
            }

            m_port = std::make_unique<boost::asio::serial_port>(m_ioc);
            boost::system::error_code ec;
            m_port->open(m_device, ec);
            if (ec) {
                err = "open " + m_device + ": " + ec.message();
                m_port.reset();
                return false;
            }

            // Скорость самого serial-порта к скорости шины отношения не имеет:
            // адаптеры Lawicel работают на 115200 8N1.
            m_port->set_option(boost::asio::serial_port_base::baud_rate(115200), ec);
            m_port->set_option(boost::asio::serial_port_base::character_size(8), ec);
            m_port->set_option(boost::asio::serial_port_base::parity(
                boost::asio::serial_port_base::parity::none), ec);
            m_port->set_option(boost::asio::serial_port_base::stop_bits(
                boost::asio::serial_port_base::stop_bits::one), ec);
            m_port->set_option(boost::asio::serial_port_base::flow_control(
                boost::asio::serial_port_base::flow_control::none), ec);

            // Адаптер мог остаться открытым от прошлого запуска: закрываем канал,
            // ставим скорость, открываем заново. На "C" при закрытом канале
            // приходит BELL — это не ошибка, поэтому ответ не проверяем.
            std::string werr;
            if (!write_command("C\r", werr) ||
                !write_command(std::string("S") + index + "\r", werr) ||
                !write_command("O\r", werr)) {
                err = werr;
                m_port->close(ec);
                m_port.reset();
                return false;
            }

            ULog::info(TAG_SLCAN, "Opened " + m_device + " @ " + std::to_string(m_bitrate));
            start_read();
            return true;
        }

        void USlcanBus::start_read() {
            if (!m_port) {
                return;
            }
            // Кадры slcan — ASCII-строки, разделитель '\r'.
            boost::asio::async_read_until(*m_port, m_buf, '\r',
                [this, self = shared_from_this()](const boost::system::error_code& ec, std::size_t) {
                    if (ec) {
                        if (ec != boost::asio::error::operation_aborted) {
                            on_failure("read: " + ec.message());
                        }
                        return;
                    }
                    std::istream is(&m_buf);
                    std::string line;
                    std::getline(is, line, '\r');
                    handle_line(line);

                    std::lock_guard<std::mutex> lock(m_mutex);
                    start_read();
                });
        }

        void USlcanBus::handle_line(const std::string& line) {
            if (line.empty()) {
                return;
            }

            // Интересуют только кадры данных: 'T' — расширенный id (29 бит),
            // 't' — стандартный (11 бит). Ответы адаптера ('z', BELL, CR) и
            // RTR-кадры игнорируем.
            const char kind = line[0];
            if (kind != 'T' && kind != 't') {
                return;
            }

            const bool extended = (kind == 'T');
            const std::size_t id_len = extended ? 8 : 3;
            if (line.size() < 1 + id_len + 1) {
                return;
            }

            auto hex = [](const std::string& s, std::size_t pos, std::size_t len, std::uint32_t& out) {
                out = 0;
                for (std::size_t i = 0; i < len; ++i) {
                    const char c = s[pos + i];
                    std::uint32_t d;
                    if (c >= '0' && c <= '9')      d = static_cast<std::uint32_t>(c - '0');
                    else if (c >= 'A' && c <= 'F') d = static_cast<std::uint32_t>(c - 'A' + 10);
                    else if (c >= 'a' && c <= 'f') d = static_cast<std::uint32_t>(c - 'a' + 10);
                    else return false;
                    out = (out << 4) | d;
                }
                return true;
            };

            FCanFrame f;
            f.extended = extended;
            if (!hex(line, 1, id_len, f.id)) {
                return;
            }

            std::uint32_t dlc = 0;
            if (!hex(line, 1 + id_len, 1, dlc) || dlc > 8) {
                return;
            }
            f.dlc = static_cast<std::uint8_t>(dlc);

            const std::size_t need = 1 + id_len + 1 + dlc * 2;
            if (line.size() < need) {
                return;
            }
            for (std::uint32_t i = 0; i < dlc; ++i) {
                std::uint32_t byte = 0;
                if (!hex(line, 1 + id_len + 1 + i * 2, 2, byte)) {
                    return;
                }
                f.data[i] = static_cast<std::uint8_t>(byte);
            }

            deliver(f);
        }

        bool USlcanBus::send(const FCanFrame& frame) {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (!m_port || !m_connected.load()) {
                return false;
            }

            char buf[32];
            std::string out;
            if (frame.extended) {
                std::snprintf(buf, sizeof(buf), "T%08X%u", frame.id & 0x1FFFFFFF, frame.dlc);
            }
            else {
                std::snprintf(buf, sizeof(buf), "t%03X%u", frame.id & 0x7FF, frame.dlc);
            }
            out = buf;
            for (std::uint8_t i = 0; i < frame.dlc; ++i) {
                std::snprintf(buf, sizeof(buf), "%02X", frame.data[i]);
                out += buf;
            }
            out += '\r';

            boost::system::error_code ec;
            boost::asio::write(*m_port, boost::asio::buffer(out), ec);
            if (ec) {
                set_error("write: " + ec.message());
                return false;
            }
            return true;
        }

        void USlcanBus::do_close() {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_port) {
                boost::system::error_code ec;
                if (m_port->is_open()) {
                    // Закрываем канал адаптера, иначе он останется висеть на шине
                    // до передёргивания USB.
                    boost::asio::write(*m_port, boost::asio::buffer(std::string("C\r")), ec);
                    m_port->close(ec);
                }
                m_port.reset();
            }
            m_buf.consume(m_buf.size());
        }

        // ------------------------------------------------------------------ фабрика

        std::shared_ptr<ICanBus> make_can_bus(boost::asio::io_context& ioc, const FCanConfig& config) {
            if (config.mode == "slcan") {
                return std::make_shared<USlcanBus>(ioc, config.device, config.bitrate);
            }
            return std::make_shared<USocketCanBus>(ioc, config.iface);
        }

    } // namespace gateway
} // namespace varan
