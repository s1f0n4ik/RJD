#pragma once

#include <string>
#include <cstdint>

#include <boost/json.hpp>

namespace varan {
    namespace gateway {

        // Настройки WebSocket-клиента, которым сервис подключается к стороннему
        // серверу (КАУС). Меняются в рантайне через REST.
        struct FWsConfig {
            std::string host = "127.0.0.1";
            std::string port = "8080";
            std::string target = "/ws/frames";
            bool enabled = true;
        };

        // Адресация одного сообщения J1939. Состав полей сообщения задан
        // протоколом и в настройках не живёт — меняется только адрес, из
        // которого собирается 29-битный id.
        struct FCanMessageId {
            int priority = 0;
            int pgn = 0;
            int addr = 0;       // SA: наш для передачи, стороннего устройства для приёма
            int dst_addr = 0;   // PS для адресных сообщений (PDU1)
            bool enabled = true; // разбирать / отправлять это сообщение
        };

        // Настройки шины CAN. Режим выбирает бэкенд: socketcan работает по
        // сетевому интерфейсу (iface), slcan — по serial port (device + bitrate).
        // Адреса и PGN вынесены в настройки, а не зашиты: на стенде и на изделии
        // они разные, а пересобирать сервис ради этого не хочется.
        struct FCanConfig {
            std::string mode = "socketcan";     // "socketcan" | "slcan"
            std::string iface = "can0";         // socketcan: имя интерфейса
            std::string device = "/dev/ttyUSB0";// slcan: serial port
            int bitrate = 250000;               // slcan: скорость шины (S0..S8)
            bool enabled = true;

            // Передача: обнаружения технического зрения.
            // Приоритет 0 | PGN 0xEF00 | SA 0x71 -> id 0x00EF0071.
            FCanMessageId tx_detections{ 0, 0xEF00, 0x71, 0x00, true };
            // Кадр уходит по таймеру независимо от gRPC. Выключить — и он будет
            // уходить только на новые обнаружения.
            bool tx_continuous = true;
            int tx_period_ms = 100;
            // Протокол задаёт 4 значащих байта, но J1939 требует все 8 в кадре.
            // По умолчанию шлём 8 (хвост — 0xFF, "недоступно"); если приёмник ждёт
            // ровно 4, ставится 4.
            int tx_dlc = 8;
            // Сколько нагрузка камеры живёт без новых кадров от media-center. Если
            // поток обнаружений встал, её бит гаснет: держать на шине последнее
            // "человек, критическая опасность" — значит показывать тревогу, которой
            // уже нет, и приёмник не отличит её от живой.
            int payload_ttl_ms = 1000;

            // Приём: сообщения стороннего устройства (Садко, SA 0x61), из которых
            // берутся координаты и время. Приоритет 6, PDU2 (широковещательные).
            FCanMessageId rx_gps{ 6, 0xFF00, 0x61, 0x00, true };
            FCanMessageId rx_time{ 6, 0xFF01, 0x61, 0x00, true };
        };

        struct FGatewayConfig {
            uint16_t rest_port = 9090;   // REST: настроечные ручки
            uint16_t grpc_port = 50051;  // gRPC: ingress кадров
            FWsConfig ws;
            FCanConfig can;
            int heartbeat_sec = 5;
        };

        inline boost::json::object to_json(const FWsConfig& c) {
            boost::json::object o;
            o["host"] = c.host;
            o["port"] = c.port;
            o["target"] = c.target;
            o["enabled"] = c.enabled;
            return o;
        }

        inline boost::json::object to_json(const FCanMessageId& m) {
            boost::json::object o;
            o["priority"] = m.priority;
            o["pgn"] = m.pgn;
            o["addr"] = m.addr;
            o["dst_addr"] = m.dst_addr;
            o["enabled"] = m.enabled;
            return o;
        }

        inline boost::json::object to_json(const FCanConfig& c) {
            boost::json::object o;
            o["mode"] = c.mode;
            o["iface"] = c.iface;
            o["device"] = c.device;
            o["bitrate"] = c.bitrate;
            o["enabled"] = c.enabled;
            o["tx_detections"] = to_json(c.tx_detections);
            o["tx_continuous"] = c.tx_continuous;
            o["tx_period_ms"] = c.tx_period_ms;
            o["tx_dlc"] = c.tx_dlc;
            o["payload_ttl_ms"] = c.payload_ttl_ms;
            o["rx_gps"] = to_json(c.rx_gps);
            o["rx_time"] = to_json(c.rx_time);
            return o;
        }

        // Частичное обновление адреса сообщения. err с префиксом имени, чтобы на
        // странице было видно, какое именно сообщение настроено неверно.
        inline bool apply_json(FCanMessageId& m, const boost::json::object& o,
            const std::string& name, std::string& err) {
            FCanMessageId t = m;
            try {
                if (auto* v = o.if_contains("priority")) t.priority = v->to_number<int>();
                if (auto* v = o.if_contains("pgn"))      t.pgn = v->to_number<int>();
                if (auto* v = o.if_contains("addr"))     t.addr = v->to_number<int>();
                if (auto* v = o.if_contains("dst_addr")) t.dst_addr = v->to_number<int>();
                if (auto* v = o.if_contains("enabled"))  t.enabled = v->as_bool();
            }
            catch (const std::exception& e) {
                err = name + ": " + e.what();
                return false;
            }

            // Адреса J1939 однобайтные, приоритет трёхбитный, PGN — 16 бит для
            // проприетарных сообщений. Выход за диапазон молча обрежется в id и
            // кадр уедет не туда, поэтому ловим здесь.
            if (t.priority < 0 || t.priority > 7)   { err = name + ".priority must be 0..7"; return false; }
            if (t.pgn < 0 || t.pgn > 0xFFFF)        { err = name + ".pgn must be 0..65535"; return false; }
            if (t.addr < 0 || t.addr > 0xFF)        { err = name + ".addr must be 0..255"; return false; }
            if (t.dst_addr < 0 || t.dst_addr > 0xFF){ err = name + ".dst_addr must be 0..255"; return false; }

            m = t;
            return true;
        }

        inline boost::json::object to_json(const FGatewayConfig& c) {
            boost::json::object o;
            o["rest_port"] = c.rest_port;
            o["grpc_port"] = c.grpc_port;
            o["heartbeat_sec"] = c.heartbeat_sec;
            o["ws"] = to_json(c.ws);
            o["can"] = to_json(c.can);
            return o;
        }

        // Частичное обновление: берём только присутствующие поля, остальное
        // оставляем как было. Возвращает false с текстом ошибки при плохом типе.
        inline bool apply_json(FWsConfig& c, const boost::json::object& o, std::string& err) {
            try {
                if (auto* v = o.if_contains("host"))    c.host = boost::json::value_to<std::string>(*v);
                if (auto* v = o.if_contains("port"))    c.port = boost::json::value_to<std::string>(*v);
                if (auto* v = o.if_contains("target"))  c.target = boost::json::value_to<std::string>(*v);
                if (auto* v = o.if_contains("enabled")) c.enabled = v->as_bool();
            }
            catch (const std::exception& e) {
                err = e.what();
                return false;
            }
            return true;
        }

        inline bool apply_json(FCanConfig& c, const boost::json::object& o, std::string& err) {
            FCanConfig t = c;  // правим копию: при плохом поле исходная не портится
            try {
                if (auto* v = o.if_contains("mode"))         t.mode = boost::json::value_to<std::string>(*v);
                if (auto* v = o.if_contains("iface"))        t.iface = boost::json::value_to<std::string>(*v);
                if (auto* v = o.if_contains("device"))       t.device = boost::json::value_to<std::string>(*v);
                if (auto* v = o.if_contains("bitrate"))      t.bitrate = v->to_number<int>();
                if (auto* v = o.if_contains("enabled"))      t.enabled = v->as_bool();
                if (auto* v = o.if_contains("tx_continuous")) t.tx_continuous = v->as_bool();
                if (auto* v = o.if_contains("tx_period_ms")) t.tx_period_ms = v->to_number<int>();
                if (auto* v = o.if_contains("tx_dlc"))       t.tx_dlc = v->to_number<int>();
                if (auto* v = o.if_contains("payload_ttl_ms")) t.payload_ttl_ms = v->to_number<int>();
            }
            catch (const std::exception& e) {
                err = e.what();
                return false;
            }

            if (auto* v = o.if_contains("tx_detections"); v && v->is_object()) {
                if (!apply_json(t.tx_detections, v->as_object(), "tx_detections", err)) return false;
            }
            if (auto* v = o.if_contains("rx_gps"); v && v->is_object()) {
                if (!apply_json(t.rx_gps, v->as_object(), "rx_gps", err)) return false;
            }
            if (auto* v = o.if_contains("rx_time"); v && v->is_object()) {
                if (!apply_json(t.rx_time, v->as_object(), "rx_time", err)) return false;
            }

            if (t.mode != "socketcan" && t.mode != "slcan") {
                err = "mode must be 'socketcan' or 'slcan'";
                return false;
            }
            if (t.mode == "socketcan" && t.iface.empty()) {
                err = "iface is required for socketcan mode";
                return false;
            }
            if (t.mode == "slcan" && t.device.empty()) {
                err = "device is required for slcan mode";
                return false;
            }
            // Два принимаемых сообщения с одним id неразличимы: второе никогда не
            // разберётся, а на странице оба выглядят настроенными.
            if (t.rx_gps.enabled && t.rx_time.enabled &&
                t.rx_gps.pgn == t.rx_time.pgn && t.rx_gps.addr == t.rx_time.addr) {
                err = "rx_gps and rx_time have the same id; give them different PGN or address";
                return false;
            }
            if (t.tx_period_ms < 10 || t.tx_period_ms > 10000) {
                err = "tx_period_ms must be 10..10000";
                return false;
            }
            if (t.tx_dlc < 4 || t.tx_dlc > 8) {
                err = "tx_dlc must be 4..8";
                return false;
            }
            // Меньше периода выдачи ttl не имеет смысла: нагрузка успевала бы
            // протухнуть между соседними кадрами и на шину всегда шли бы нули.
            if (t.payload_ttl_ms < t.tx_period_ms) {
                err = "payload_ttl_ms must be >= tx_period_ms";
                return false;
            }

            c = t;
            return true;
        }

    } // namespace gateway
} // namespace varan
