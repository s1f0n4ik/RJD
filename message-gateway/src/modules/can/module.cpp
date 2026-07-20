#include "gateway/modules/can/module.h"
#include "gateway/utility/clock.h"
#include "gateway/utility/log.h"

#include <algorithm>
#include <cstdio>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {

            const char* TAG = "module:can";

            std::string hex_byte(int v) {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "0x%02X", v & 0xFF);
                return buf;
            }

            std::uint32_t id_of(const FCanMessageId& m) {
                return make_j1939_id(m.priority, m.pgn, m.addr, m.dst_addr);
            }

            std::string coord(double v, const char* pos, const char* neg) {
                char buf[32];
                std::snprintf(buf, sizeof(buf), "%.4f° %s", v < 0 ? -v : v, v < 0 ? neg : pos);
                return buf;
            }

            // Список камер маски как "1, 2" — на странице читается лучше, чем 0x03.
            std::string mask_note(int mask) {
                std::string out;
                for (int b = 1; b <= 8; ++b) {
                    if (mask & (1 << (b - 1))) {
                        if (!out.empty()) out += ", ";
                        out += std::to_string(b);
                    }
                }
                return out;
            }

        } // namespace

        UCanModule::UCanModule(boost::asio::io_context& ioc, FCanConfig config,
            const UTaxonomy& taxonomy, UTimeSource& time_source)
            : m_ioc(ioc)
            , m_taxonomy(taxonomy)
            , m_time(time_source)
            , m_config(std::move(config))
            , m_tx_timer(ioc)
        {
            m_sum_tx = { "tx_detections", "Обнаружения", true, true, 0, 0, 0, 0, 0, {}, "" };
            m_sum_gps = { "rx_gps", "Координаты", false, true, 0, 0, 0, 0, 0, {}, "" };
            m_sum_time = { "rx_time", "Дата, время и скорость", false, true, 0, 0, 0, 0, 0, {}, "" };
        }

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

        // Приём кадров с шины. Интересуют только сообщения стороннего устройства:
        // по ним синхронизируются время и координаты всего сервиса.
        void UCanModule::on_bus_frame(const FCanFrame& frame) {
            const FCanConfig cfg = config();
            const std::int64_t ts = now_ms();

            const bool is_gps = cfg.rx_gps.enabled && frame.id == id_of(cfg.rx_gps);
            const bool is_time = cfg.rx_time.enabled && frame.id == id_of(cfg.rx_time);

            if (!is_gps && !is_time) {
                // Чужой трафик на шине — норма, в ленту его не пишем, чтобы не
                // топить в нём свои сообщения. Считаем, чтобы было видно жизнь.
                m_rx_other.fetch_add(1);
                return;
            }

            std::string err;
            if (is_gps) {
                FCanGps gps;
                if (!decode_gps_frame(frame, gps, err)) {
                    std::lock_guard<std::mutex> lock(m_sum_mutex);
                    m_sum_gps.errors++;
                    m_log.push(frame, false, ts, "", err);
                    return;
                }
                // Скорость приходит в сообщении времени, здесь её нет: берём ту,
                // что уже известна источнику, чтобы не затирать нулём.
                m_time.update_gps(gps.lat, gps.lon, m_time.snapshot_struct().speed);

                const std::string note = coord(gps.lat, "N", "S") + " · " + coord(gps.lon, "E", "W");
                {
                    std::lock_guard<std::mutex> lock(m_sum_mutex);
                    m_sum_gps.count++;
                    m_sum_gps.id = frame.id;
                    m_sum_gps.dlc = frame.dlc;
                    m_sum_gps.data = frame.data;
                    m_sum_gps.note = note;
                    m_sum_gps.last_mono = mono_ms();
                }
                m_log.push(frame, false, ts, note, "");
                return;
            }

            FCanTime t;
            if (!decode_time_frame(frame, t, err)) {
                std::lock_guard<std::mutex> lock(m_sum_mutex);
                m_sum_time.errors++;
                m_log.push(frame, false, ts, "", err);
                return;
            }
            m_time.update_time(t.unix_ms);
            // Скорость идёт вместе с временем, а координаты — отдельным
            // сообщением: обновляем её, сохранив последние координаты.
            const auto snap = m_time.snapshot_struct();
            m_time.update_gps(snap.lat, snap.lon, t.speed);

            char buf[96];
            const std::time_t tt = static_cast<std::time_t>(t.unix_ms / 1000);
            std::tm tm{};
#if defined(_WIN32)
            gmtime_s(&tm, &tt);
#else
            gmtime_r(&tt, &tm);
#endif
            std::snprintf(buf, sizeof(buf), "%02d.%02d.%04d %02d:%02d:%02d UTC · %.2f м/с",
                tm.tm_mday, tm.tm_mon + 1, tm.tm_year + 1900,
                tm.tm_hour, tm.tm_min, tm.tm_sec, t.speed);

            {
                std::lock_guard<std::mutex> lock(m_sum_mutex);
                m_sum_time.count++;
                m_sum_time.id = frame.id;
                m_sum_time.dlc = frame.dlc;
                m_sum_time.data = frame.data;
                m_sum_time.note = buf;
                m_sum_time.last_mono = mono_ms();
            }
            m_log.push(frame, false, ts, buf, "");
        }

        void UCanModule::expire_cameras_locked(const FCanConfig& cfg) {
            const std::int64_t now = mono_ms();
            for (auto& c : m_cameras) {
                if (c.mono != 0 && (now - c.mono) > cfg.payload_ttl_ms) {
                    // Камера замолчала: гасим её вклад, но саму запись оставляем —
                    // страница должна показывать, что камера известна и молчит.
                    c.count = 0;
                    c.type = 0;
                    c.danger = 0;
                    c.mono = 0;
                }
            }
        }

        FCanDetectionPayload UCanModule::build_payload_locked(const FCanConfig&) const {
            FCanDetectionPayload p;
            for (const auto& c : m_cameras) {
                if (c.mono == 0 || c.count == 0) {
                    continue;
                }
                p.count += c.count;
                if (c.bit >= 1 && c.bit <= 8) {
                    p.camera_mask |= (1 << (c.bit - 1));
                }
                // Тип отдаём у обнаружения с самым высоким классом опасности: в
                // четыре байта помещается только одно, и это должно быть самое
                // опасное — по всем камерам сразу.
                if (c.danger > p.danger) {
                    p.danger = c.danger;
                    p.type = c.type;
                }
            }
            return p;
        }

        // Кадр от media-center обновляет вклад своей камеры. Отправку делает
        // таймер, а при выключенной постоянной передаче — этот же вызов.
        FSubmitResult UCanModule::handle_frame(const FFrameMessage& msg) {
            FSubmitResult result;
            result.ver = msg.ver;
            result.transport = "can";

            const std::int64_t ts_recv = now_ms();
            const int det_count = static_cast<int>(msg.dets.size());
            const FCanConfig cfg = config();

            int type = 0, danger = 0;
            bool passthrough = false;
            for (const auto& d : msg.dets) {
                const auto r = m_taxonomy.resolve(msg.config_id, d);
                passthrough = passthrough || r.passthrough;
                if (r.danger > danger) {
                    danger = r.danger;
                    type = r.type;
                }
            }
            if (passthrough) {
                m_passthrough_frames.fetch_add(1);
            }

            const int bit = m_taxonomy.camera_bit(msg.camera_id);
            if (bit == 0 && det_count > 0) {
                // Камеры нет в таблице — бит ставить некуда. Обнаружения попадут
                // в счётчик кадра, но какая камера сработала, приёмник не узнает.
                m_unmapped_cameras.fetch_add(1);
            }

            if (!connected()) {
                result.status = ESubmitStatus::NotConnected;
                result.error = "can bus not connected";
                m_stats.on_frame_rejected(msg.id, ts_recv, msg.ver, det_count, result.error);
                return result;
            }

            {
                std::lock_guard<std::mutex> lock(m_payload_mutex);
                auto it = std::find_if(m_cameras.begin(), m_cameras.end(),
                    [&](const FCameraState& c) { return c.key == msg.camera_id; });
                if (it == m_cameras.end()) {
                    m_cameras.push_back(FCameraState{ msg.camera_id, bit, 0, 0, 0, 0 });
                    it = std::prev(m_cameras.end());
                }
                // Бит перечитываем каждый раз: таблицу могли поправить по REST
                // уже после того, как камера впервые дала о себе знать.
                it->bit = bit;
                it->count = det_count;
                it->type = type;
                it->danger = danger;
                it->mono = mono_ms();
            }

            m_stats.on_frame_sent(msg.id, ts_recv, msg.ver, det_count, cfg.tx_dlc, !msg.image.empty());

            if (!cfg.tx_continuous) {
                transmit(cfg, true);
            }

            result.status = ESubmitStatus::Accepted;
            result.wire_size = cfg.tx_dlc;
            return result;
        }

        void UCanModule::transmit(const FCanConfig& cfg, bool) {
            if (!cfg.tx_detections.enabled) {
                return;
            }

            std::shared_ptr<ICanBus> bus;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                bus = m_bus;
            }
            // Пока шины нет, кадры не копим: на шину уходит только актуальное
            // состояние, очередь тут не нужна.
            if (!bus || !bus->connected()) {
                return;
            }

            FCanDetectionPayload payload;
            {
                std::lock_guard<std::mutex> lock(m_payload_mutex);
                expire_cameras_locked(cfg);
                payload = build_payload_locked(cfg);
            }

            const FCanFrame frame = encode_detection_frame(
                payload, cfg.tx_detections.priority, cfg.tx_detections.pgn,
                cfg.tx_detections.addr, cfg.tx_detections.dst_addr, cfg.tx_dlc);

            const std::int64_t ts = now_ms();
            if (!bus->send(frame)) {
                std::lock_guard<std::mutex> lock(m_sum_mutex);
                m_sum_tx.errors++;
                m_log.push(frame, true, ts, "",
                    bus->last_error().empty() ? "can write failed" : bus->last_error());
                return;
            }

            std::string note;
            if (payload.count == 0) {
                note = "обнаружений нет";
            }
            else {
                note = std::to_string(payload.count) + " обн. · " +
                    UTaxonomy::type_title(payload.type) + " · " +
                    UTaxonomy::danger_title(payload.danger) +
                    " · камеры " + mask_note(payload.camera_mask);
            }

            {
                std::lock_guard<std::mutex> lock(m_sum_mutex);
                m_sum_tx.count++;
                m_sum_tx.id = frame.id;
                m_sum_tx.dlc = frame.dlc;
                m_sum_tx.data = frame.data;
                m_sum_tx.note = note;
                m_sum_tx.last_mono = mono_ms();
            }
            m_log.push(frame, true, ts, note, "");
        }

        // Раз в 5 секунд пишем в лог, сколько кадров ушло и сколько пришло.
        // Главное здесь — приём: если суммарный RX (координаты + время + чужие)
        // держится на нуле при растущем TX, значит на шину физически ничего не
        // приходит, и разбираться надо не в коде, а в проводах и скорости шины.
        void UCanModule::heartbeat() {
            const std::int64_t now = mono_ms();
            if (m_last_hb_mono != 0 && now - m_last_hb_mono < 5000) {
                return;
            }
            m_last_hb_mono = now;

            std::int64_t gps = 0, gps_err = 0, tm = 0, tm_err = 0, tx = 0, tx_err = 0;
            {
                std::lock_guard<std::mutex> lock(m_sum_mutex);
                gps = m_sum_gps.count; gps_err = m_sum_gps.errors;
                tm = m_sum_time.count; tm_err = m_sum_time.errors;
                tx = m_sum_tx.count; tx_err = m_sum_tx.errors;
            }
            const std::int64_t other = m_rx_other.load();
            const std::int64_t rx_total = gps + tm + other;

            std::string msg = "tx=" + std::to_string(tx) + " (ошибок " + std::to_string(tx_err) + ")"
                + " | rx всего=" + std::to_string(rx_total)
                + " [координаты " + std::to_string(gps) + "/ош " + std::to_string(gps_err)
                + ", время " + std::to_string(tm) + "/ош " + std::to_string(tm_err)
                + ", чужих " + std::to_string(other) + "]";

            if (rx_total == 0) {
                msg += " — с шины не пришло ни одного кадра: проверьте провода, "
                    "терминаторы 120 Ом и скорость шины на обоих узлах";
                ULog::warn(TAG, msg);
            }
            else {
                ULog::info(TAG, msg);
            }
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
                // Без постоянной передачи таймер только гасит протухшие камеры;
                // сам кадр уходит из handle_frame по приходу обнаружений.
                if (cfg.tx_continuous) {
                    transmit(cfg, false);
                }
                else {
                    std::lock_guard<std::mutex> lock(m_payload_mutex);
                    expire_cameras_locked(cfg);
                }
                heartbeat();
                start_tx();
            });
        }

        std::vector<UCanLog::FSummary> UCanModule::summaries() const {
            const FCanConfig cfg = config();
            std::lock_guard<std::mutex> lock(m_sum_mutex);

            UCanLog::FSummary tx = m_sum_tx;
            tx.enabled = cfg.tx_detections.enabled;
            tx.id = id_of(cfg.tx_detections);

            UCanLog::FSummary gps = m_sum_gps;
            gps.enabled = cfg.rx_gps.enabled;
            gps.id = id_of(cfg.rx_gps);

            UCanLog::FSummary tm = m_sum_time;
            tm.enabled = cfg.rx_time.enabled;
            tm.id = id_of(cfg.rx_time);

            return { tx, gps, tm };
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

            // Сообщения: адресация целиком, чтобы страница собрала раздел без
            // догадок, плюс готовый id — на шине искать проще по нему.
            auto message_json = [](const char* key, const char* title, bool tx,
                const FCanMessageId& m) {
                    json::object o;
                    o["key"] = key;
                    o["title"] = title;
                    o["dir"] = tx ? "tx" : "rx";
                    o["priority"] = m.priority;
                    o["pgn"] = m.pgn;
                    o["addr"] = m.addr;
                    o["dst_addr"] = m.dst_addr;
                    o["enabled"] = m.enabled;
                    o["id"] = UCanLog::hex_id(id_of(m));
                    o["pgn_hex"] = [&] {
                        char b[8]; std::snprintf(b, sizeof(b), "0x%04X", m.pgn & 0xFFFF); return std::string(b);
                    }();
                    o["addr_hex"] = hex_byte(m.addr);
                    return o;
                };

            json::array messages;
            messages.push_back(message_json("tx_detections", "Обнаружения", true, cfg.tx_detections));
            messages.push_back(message_json("rx_gps", "Координаты", false, cfg.rx_gps));
            messages.push_back(message_json("rx_time", "Дата, время и скорость", false, cfg.rx_time));

            json::object tx;
            tx["continuous"] = cfg.tx_continuous;
            tx["period_ms"] = cfg.tx_period_ms;
            tx["dlc"] = cfg.tx_dlc;
            tx["payload_ttl_ms"] = cfg.payload_ttl_ms;

            // Текущая нагрузка — то, что прямо сейчас уходит на шину, вместе с
            // вкладом каждой камеры: по нему видно, чей бит поднят и почему.
            FCanDetectionPayload payload;
            json::array cams;
            {
                std::lock_guard<std::mutex> lock(m_payload_mutex);
                payload = build_payload_locked(cfg);
                for (const auto& c : m_cameras) {
                    json::object o;
                    o["key"] = c.key;
                    o["bit"] = c.bit;
                    o["count"] = c.count;
                    o["active"] = c.mono != 0 && c.count > 0;
                    o["age_ms"] = c.mono ? (mono_ms() - c.mono) : -1;
                    cams.push_back(std::move(o));
                }
            }

            json::object pj;
            pj["count"] = payload.count;
            pj["type"] = payload.type;
            pj["danger"] = payload.danger;
            pj["camera_mask"] = payload.camera_mask;
            pj["camera_bits"] = mask_note(payload.camera_mask);
            pj["type_title"] = payload.type ? UTaxonomy::type_title(payload.type) : std::string("—");
            pj["danger_title"] = payload.danger ? UTaxonomy::danger_title(payload.danger) : std::string("—");
            pj["cameras"] = std::move(cams);
            pj["unmapped_cameras"] = m_unmapped_cameras.load();
            pj["passthrough_frames"] = m_passthrough_frames.load();

            json::array summaries;
            for (const auto& s : this->summaries()) {
                summaries.push_back(UCanLog::summary_json(s));
            }

            json::object m;
            m["id"] = id();
            m["title"] = title();
            m["transport"] = transport();
            m["heartbeat_sec"] = 0;  // у CAN своя периодика — tx.period_ms
            m["protocol_versions"] = json::array{};
            m["connection"] = std::move(connection);
            m["messages"] = std::move(messages);
            m["tx"] = std::move(tx);
            m["payload"] = std::move(pj);
            m["summaries"] = std::move(summaries);
            m["log"] = m_log.to_json();
            m["rx_other"] = m_rx_other.load();
            m["stats"] = m_stats.to_json();
            return m;
        }

        boost::json::object UCanModule::config_snapshot() const {
            return varan::gateway::to_json(config());
        }

        bool UCanModule::apply_config(const json::object& patch, std::string& err) {
            FCanConfig updated = config();
            if (!varan::gateway::apply_json(updated, patch, err)) {
                return false;
            }

            {
                std::lock_guard<std::mutex> lock(m_mutex);
                const bool bus_changed =
                    m_config.mode != updated.mode ||
                    m_config.iface != updated.iface ||
                    m_config.device != updated.device ||
                    m_config.bitrate != updated.bitrate ||
                    m_config.enabled != updated.enabled;

                m_config = updated;
                // Шину дёргаем только когда поменялось то, что её определяет:
                // правка PGN не должна ронять живое соединение.
                if (m_active.load() && bus_changed) {
                    rebuild_bus_locked();
                }
            }

            ULog::info(TAG, "Reconfigured -> " + updated.mode + ":" +
                (updated.mode == "slcan" ? updated.device : updated.iface));
            return true;
        }

    } // namespace gateway
} // namespace varan
