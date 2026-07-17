#include "gateway/can-module.h"
#include "gateway/clock.h"
#include "gateway/log.h"

#include <cstdio>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {

            const char* TAG = "module:can";

            std::string hex_id(std::uint32_t id) {
                char buf[16];
                std::snprintf(buf, sizeof(buf), "0x%08X", id);
                return buf;
            }

            std::string hex_byte(int v) {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "0x%02X", v & 0xFF);
                return buf;
            }

        } // namespace

        UCanModule::UCanModule(boost::asio::io_context& ioc, FCanConfig config,
            const UTaxonomy& taxonomy, UTimeSource& time_source)
            : m_ioc(ioc)
            , m_taxonomy(taxonomy)
            , m_time(time_source)
            , m_config(std::move(config))
            , m_tx_timer(ioc)
        {}

        FCanConfig UCanModule::config() const {
            std::lock_guard<std::mutex> lock(m_mutex);
            return m_config;
        }

        void UCanModule::rebuild_bus_locked() {
            if (m_bus) {
                m_bus->close();
                m_bus.reset();
            }
            if (!m_config.enabled) {
                ULog::info(TAG, "Disabled, bus not opened");
                return;
            }
            m_bus = make_can_bus(m_ioc, m_config);
            m_bus->set_frame_handler([this](const FCanFrame& f) { on_bus_frame(f); });
            m_bus->open();
        }

        void UCanModule::start() {
            if (m_active.exchange(true)) {
                return;
            }
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                rebuild_bus_locked();
            }
            // Таймер трогаем только из потока io_context шины: start() зовётся из
            // REST-потока, а steady_timer гонки не переживает.
            boost::asio::post(m_ioc, [this] { start_tx(); });
            ULog::info(TAG, "Started");
        }

        void UCanModule::stop() {
            if (!m_active.exchange(false)) {
                return;
            }
            boost::asio::post(m_ioc, [this] { m_tx_timer.cancel(); });
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (m_bus) {
                    m_bus->close();
                    m_bus.reset();
                }
            }
            ULog::info(TAG, "Stopped");
        }

        bool UCanModule::connected() const {
            std::lock_guard<std::mutex> lock(m_mutex);
            return m_bus && m_bus->connected();
        }

        // Приём кадров с шины. Интересуют только сообщения Садко: по ним
        // синхронизируются время и координаты всего сервиса.
        void UCanModule::on_bus_frame(const FCanFrame& frame) {
            const FCanConfig cfg = config();
            const FJ1939Id j = parse_j1939_id(frame.id);

            if (j.src != cfg.peer_addr) {
                m_rx_other.fetch_add(1);
                return;
            }

            std::string err;
            if (j.pgn == cfg.gps_pgn) {
                FCanGps gps;
                if (!decode_gps_frame(frame, gps, err)) {
                    m_rx_errors.fetch_add(1);
                    std::lock_guard<std::mutex> lock(m_rx_mutex);
                    m_rx_last_error = err;
                    return;
                }
                // Скорость приходит в сообщении времени, здесь её нет: берём ту,
                // что уже известна источнику, чтобы не затирать нулём.
                m_time.update_gps(gps.lat, gps.lon, m_time.snapshot_struct().speed);
                m_rx_gps.fetch_add(1);
                return;
            }

            if (j.pgn == cfg.time_pgn) {
                FCanTime t;
                if (!decode_time_frame(frame, t, err)) {
                    m_rx_errors.fetch_add(1);
                    std::lock_guard<std::mutex> lock(m_rx_mutex);
                    m_rx_last_error = err;
                    return;
                }
                m_time.update_time(t.unix_ms);
                // Скорость идёт вместе с временем, а координаты — отдельным
                // сообщением: обновляем её, сохранив последние координаты.
                const auto snap = m_time.snapshot_struct();
                m_time.update_gps(snap.lat, snap.lon, t.speed);
                m_rx_time.fetch_add(1);
                return;
            }

            m_rx_other.fetch_add(1);
        }

        // Кадр от media-center только обновляет нагрузку. Отправку делает таймер.
        FSubmitResult UCanModule::handle_frame(const FFrameMessage& msg) {
            FSubmitResult result;
            result.ver = msg.ver;
            result.transport = "can";

            const std::int64_t ts_recv = now_ms();
            const int det_count = static_cast<int>(msg.dets.size());

            FCanDetectionPayload p;
            p.count = det_count;
            p.camera = m_taxonomy.resolve_camera(msg.camera_id);

            // Тип отдаём у обнаружения с самым высоким классом опасности: в четыре
            // байта помещается только одно, и это должно быть самое опасное.
            for (const auto& d : msg.dets) {
                const auto r = m_taxonomy.resolve(d);
                if (r.danger > p.danger) {
                    p.danger = r.danger;
                    p.type = r.type;
                }
            }

            if (!connected()) {
                result.status = ESubmitStatus::NotConnected;
                result.error = "can bus not connected";
                m_stats.on_frame_rejected(msg.id, ts_recv, msg.ver, det_count, result.error);
                return result;
            }

            {
                std::lock_guard<std::mutex> lock(m_payload_mutex);
                m_payload = p;
                m_payload_mono = mono_ms();

                m_pending = true;
                m_pending_id = msg.id;
                m_pending_ts = ts_recv;
                m_pending_dets = det_count;
                m_pending_image = !msg.image.empty();
            }

            result.status = ESubmitStatus::Accepted;
            result.wire_size = config().tx_dlc;
            return result;
        }

        void UCanModule::start_tx() {
            if (!m_active.load()) {
                return;
            }
            const FCanConfig cfg = config();

            m_tx_timer.expires_after(std::chrono::milliseconds(cfg.tx_period_ms));
            m_tx_timer.async_wait([this](const boost::system::error_code& ec) {
                if (ec || !m_active.load()) {
                    return;
                }

                const FCanConfig cfg = config();

                std::shared_ptr<ICanBus> bus;
                {
                    std::lock_guard<std::mutex> lock(m_mutex);
                    bus = m_bus;
                }

                // Пока шины нет, кадры не копим: на шину уходит только актуальное
                // состояние, очередь тут не нужна.
                if (bus && bus->connected()) {
                    FCanDetectionPayload payload;
                    bool pending = false;
                    std::int64_t pid = 0, pts = 0;
                    int pdets = 0;
                    bool pimage = false;

                    {
                        std::lock_guard<std::mutex> lock(m_payload_mutex);
                        // Протухшую нагрузку обнуляем: поток обнаружений встал, и
                        // старая тревога на шине уже не соответствует реальности.
                        if (m_payload_mono != 0 &&
                            (mono_ms() - m_payload_mono) > cfg.payload_ttl_ms) {
                            m_payload = FCanDetectionPayload{};
                            m_payload_mono = 0;
                        }
                        payload = m_payload;

                        pending = m_pending;
                        pid = m_pending_id;
                        pts = m_pending_ts;
                        pdets = m_pending_dets;
                        pimage = m_pending_image;
                        m_pending = false;
                    }

                    const FCanFrame frame = encode_detection_frame(
                        payload, cfg.tx_priority, cfg.tx_pgn, cfg.src_addr, cfg.dst_addr, cfg.tx_dlc);

                    if (bus->send(frame)) {
                        if (pending) {
                            m_stats.on_frame_sent(pid, pts, 0, pdets, frame.dlc, pimage);
                        }
                        else {
                            m_stats.on_frame_repeated(frame.dlc);
                        }
                    }
                    else if (pending) {
                        m_stats.on_frame_rejected(pid, pts, 0, pdets, bus->last_error().empty()
                            ? "can write failed" : bus->last_error());
                    }
                }

                start_tx();
            });
        }

        boost::json::object UCanModule::to_json() const {
            const FCanConfig cfg = config();

            std::shared_ptr<ICanBus> bus;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                bus = m_bus;
            }
            const bool is_connected = bus && bus->connected();

            json::object connection;
            connection["connected"] = is_connected;
            connection["enabled"] = cfg.enabled;
            connection["mode"] = cfg.mode;
            connection["iface"] = cfg.iface;
            connection["device"] = cfg.device;
            connection["bitrate"] = cfg.bitrate;
            // url — общее для всех модулей поле "куда подключён": страница рисует
            // его одинаково и для ws://, и для шины.
            connection["url"] = bus ? bus->describe()
                : (cfg.mode == "slcan" ? cfg.device : cfg.iface);
            connection["error"] = bus ? bus->last_error() : std::string();

            // Адресация J1939 — и числами, и готовым id: на шине искать проще по id.
            json::object addressing;
            addressing["src_addr"] = cfg.src_addr;
            addressing["dst_addr"] = cfg.dst_addr;
            addressing["peer_addr"] = cfg.peer_addr;
            addressing["tx_pgn"] = cfg.tx_pgn;
            addressing["tx_priority"] = cfg.tx_priority;
            addressing["tx_dlc"] = cfg.tx_dlc;
            addressing["tx_period_ms"] = cfg.tx_period_ms;
            addressing["payload_ttl_ms"] = cfg.payload_ttl_ms;
            addressing["gps_pgn"] = cfg.gps_pgn;
            addressing["time_pgn"] = cfg.time_pgn;
            addressing["tx_id"] = hex_id(make_j1939_id(cfg.tx_priority, cfg.tx_pgn, cfg.src_addr, cfg.dst_addr));
            addressing["gps_id"] = hex_id(make_j1939_id(6, cfg.gps_pgn, cfg.peer_addr, 0));
            addressing["time_id"] = hex_id(make_j1939_id(6, cfg.time_pgn, cfg.peer_addr, 0));
            addressing["src_addr_hex"] = hex_byte(cfg.src_addr);
            addressing["peer_addr_hex"] = hex_byte(cfg.peer_addr);

            // Текущая нагрузка — то, что прямо сейчас уходит на шину. Расшифровку
            // берём из общей таблицы, чтобы на странице были названия, а не числа.
            FCanDetectionPayload payload;
            std::int64_t age = -1;
            {
                std::lock_guard<std::mutex> lock(m_payload_mutex);
                payload = m_payload;
                if (m_payload_mono != 0) {
                    age = mono_ms() - m_payload_mono;
                }
            }

            json::object pj;
            pj["count"] = payload.count;
            pj["type"] = payload.type;
            pj["danger"] = payload.danger;
            pj["camera"] = payload.camera;
            pj["type_title"] = payload.type ? UTaxonomy::type_title(payload.type) : std::string("—");
            pj["danger_title"] = payload.danger ? UTaxonomy::danger_title(payload.danger) : std::string("—");
            pj["age_ms"] = age;

            json::object rx;
            rx["gps"] = m_rx_gps.load();
            rx["time"] = m_rx_time.load();
            rx["errors"] = m_rx_errors.load();
            rx["other"] = m_rx_other.load();
            {
                std::lock_guard<std::mutex> lock(m_rx_mutex);
                rx["last_error"] = m_rx_last_error;
            }

            json::object m;
            m["id"] = id();
            m["title"] = title();
            m["transport"] = transport();
            m["heartbeat_sec"] = 0;  // у CAN своя периодика — tx_period_ms
            m["protocol_versions"] = json::array{};
            m["connection"] = std::move(connection);
            m["addressing"] = std::move(addressing);
            m["payload"] = std::move(pj);
            m["rx"] = std::move(rx);
            m["stats"] = m_stats.to_json();
            return m;
        }

        bool UCanModule::apply_config(const json::object& patch, std::string& err) {
            FCanConfig updated = config();
            if (!varan::gateway::apply_json(updated, patch, err)) {
                return false;
            }

            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_config = updated;
                // Режим, устройство и скорость меняют саму шину, поэтому её проще
                // поднять заново, чем править на ходу.
                if (m_active.load()) {
                    rebuild_bus_locked();
                }
            }

            ULog::info(TAG, "Reconfigured -> " + updated.mode + ":" +
                (updated.mode == "slcan" ? updated.device : updated.iface));
            return true;
        }

    } // namespace gateway
} // namespace varan
