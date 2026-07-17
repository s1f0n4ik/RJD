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

            // Наш адрес в сети J1939 и параметры исходящего сообщения обнаружений.
            // 29-битный id собирается как priority|PGN|src_addr -> 0x00EF0071.
            int src_addr = 0x71;      // SA технического зрения
            int dst_addr = 0x00;      // PS: PGN 0xEF00 адресный (PDU1)
            int tx_pgn = 0xEF00;
            int tx_priority = 0;
            int tx_period_ms = 100;   // период выдачи обнаружений на шину
            // Протокол задаёт 4 значащих байта, но J1939 требует все 8 в кадре.
            // По умолчанию шлём 8 (хвост — 0xFF, "недоступно"); если приёмник ждёт
            // ровно 4, ставится 4.
            int tx_dlc = 8;
            // Сколько нагрузка живёт без новых кадров от media-center. Если поток
            // обнаружений встал, дальше уходят нули: держать на шине последнее
            // "человек, критическая опасность" — значит показывать тревогу, которой
            // уже нет, и приёмник не отличит её от живой.
            int payload_ttl_ms = 1000;

            // Стороннее устройство (Садко) и его сообщения, из которых берём
            // время и координаты.
            int peer_addr = 0x61;     // SA Садко
            int gps_pgn = 0xFF00;
            int time_pgn = 0xFF01;
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

        inline boost::json::object to_json(const FCanConfig& c) {
            boost::json::object o;
            o["mode"] = c.mode;
            o["iface"] = c.iface;
            o["device"] = c.device;
            o["bitrate"] = c.bitrate;
            o["enabled"] = c.enabled;
            o["src_addr"] = c.src_addr;
            o["dst_addr"] = c.dst_addr;
            o["tx_pgn"] = c.tx_pgn;
            o["tx_priority"] = c.tx_priority;
            o["tx_period_ms"] = c.tx_period_ms;
            o["tx_dlc"] = c.tx_dlc;
            o["payload_ttl_ms"] = c.payload_ttl_ms;
            o["peer_addr"] = c.peer_addr;
            o["gps_pgn"] = c.gps_pgn;
            o["time_pgn"] = c.time_pgn;
            return o;
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
                if (auto* v = o.if_contains("src_addr"))     t.src_addr = v->to_number<int>();
                if (auto* v = o.if_contains("dst_addr"))     t.dst_addr = v->to_number<int>();
                if (auto* v = o.if_contains("tx_pgn"))       t.tx_pgn = v->to_number<int>();
                if (auto* v = o.if_contains("tx_priority"))  t.tx_priority = v->to_number<int>();
                if (auto* v = o.if_contains("tx_period_ms")) t.tx_period_ms = v->to_number<int>();
                if (auto* v = o.if_contains("tx_dlc"))       t.tx_dlc = v->to_number<int>();
                if (auto* v = o.if_contains("payload_ttl_ms")) t.payload_ttl_ms = v->to_number<int>();
                if (auto* v = o.if_contains("peer_addr"))    t.peer_addr = v->to_number<int>();
                if (auto* v = o.if_contains("gps_pgn"))      t.gps_pgn = v->to_number<int>();
                if (auto* v = o.if_contains("time_pgn"))     t.time_pgn = v->to_number<int>();
            }
            catch (const std::exception& e) {
                err = e.what();
                return false;
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
            // Адреса J1939 однобайтные, приоритет трёхбитный, PGN — 16 бит для
            // проприетарных сообщений. Выход за диапазон молча обрежется в id и
            // кадр уедет не туда, поэтому ловим здесь.
            if (t.src_addr < 0 || t.src_addr > 0xFF)       { err = "src_addr must be 0..255"; return false; }
            if (t.dst_addr < 0 || t.dst_addr > 0xFF)       { err = "dst_addr must be 0..255"; return false; }
            if (t.peer_addr < 0 || t.peer_addr > 0xFF)     { err = "peer_addr must be 0..255"; return false; }
            if (t.tx_priority < 0 || t.tx_priority > 7)    { err = "tx_priority must be 0..7"; return false; }
            if (t.tx_pgn < 0 || t.tx_pgn > 0xFFFF)         { err = "tx_pgn must be 0..65535"; return false; }
            if (t.gps_pgn < 0 || t.gps_pgn > 0xFFFF)       { err = "gps_pgn must be 0..65535"; return false; }
            if (t.time_pgn < 0 || t.time_pgn > 0xFFFF)     { err = "time_pgn must be 0..65535"; return false; }
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
