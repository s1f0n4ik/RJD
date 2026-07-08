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

        struct FGatewayConfig {
            uint16_t rest_port = 9090;   // REST: настроечные ручки
            uint16_t grpc_port = 50051;  // gRPC: ingress кадров
            FWsConfig ws;
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

        inline boost::json::object to_json(const FGatewayConfig& c) {
            boost::json::object o;
            o["rest_port"] = c.rest_port;
            o["grpc_port"] = c.grpc_port;
            o["heartbeat_sec"] = c.heartbeat_sec;
            o["ws"] = to_json(c.ws);
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

    } // namespace gateway
} // namespace varan
