#include "gateway/core/neural-health.h"

#include <chrono>

#include <boost/beast.hpp>

namespace varan {
    namespace gateway {
        namespace neural_health {

            namespace json = boost::json;

            namespace {

                constexpr int HTTP_TIMEOUT_SEC = 8;

                // GET base + path, base вида http://host:port[/prefix]
                bool http_get(const std::string& base, const std::string& path, std::string& body, std::string& err) {
                    namespace beast = boost::beast;
                    namespace http = beast::http;
                    namespace asio = boost::asio;

                    std::string rest = base.rfind("http://", 0) == 0 ? base.substr(7) : base;
                    const auto slash = rest.find('/');
                    std::string prefix = slash == std::string::npos ? std::string() : rest.substr(slash);
                    if (!prefix.empty() && prefix.back() == '/') {
                        prefix.pop_back();
                    }
                    const std::string hostport = rest.substr(0, slash);
                    const auto colon = hostport.rfind(':');
                    const std::string host = colon == std::string::npos ? hostport : hostport.substr(0, colon);
                    const std::string port = colon == std::string::npos ? "80" : hostport.substr(colon + 1);

                    asio::io_context ioc;
                    asio::ip::tcp::resolver resolver(ioc);
                    beast::tcp_stream stream(ioc);
                    http::request<http::empty_body> req{ http::verb::get, prefix + path, 11 };
                    req.set(http::field::host, host);
                    req.set(http::field::user_agent, "message-gateway");
                    beast::flat_buffer buffer;
                    http::response<http::string_body> res;
                    beast::error_code result;

                    stream.expires_after(std::chrono::seconds(HTTP_TIMEOUT_SEC));
                    resolver.async_resolve(host, port,
                        [&](const beast::error_code& ec, const asio::ip::tcp::resolver::results_type& results) {
                            if (ec) {
                                result = ec;
                                return;
                            }
                            stream.async_connect(results, [&](const beast::error_code& ec, const asio::ip::tcp::endpoint&) {
                                if (ec) {
                                    result = ec;
                                    return;
                                }
                                http::async_write(stream, req, [&](const beast::error_code& ec, std::size_t) {
                                    if (ec) {
                                        result = ec;
                                        return;
                                    }
                                    http::async_read(stream, buffer, res,
                                        [&](const beast::error_code& ec, std::size_t) { result = ec; });
                                });
                            });
                        });
                    ioc.run();

                    if (result) {
                        err = result.message();
                        return false;
                    }
                    if (res.result() != http::status::ok) {
                        err = "HTTP " + std::to_string(res.result_int());
                        return false;
                    }
                    body = std::move(res.body());
                    beast::error_code ignore;
                    stream.socket().shutdown(asio::ip::tcp::socket::shutdown_both, ignore);
                    return true;
                }

                std::int64_t num(const json::object& o, const char* key) {
                    const auto* v = o.if_contains(key);
                    return v && v->is_number() ? v->to_number<std::int64_t>() : 0;
                }

                std::string plural(std::int64_t n, const char* one, const char* few, const char* many) {
                    const std::int64_t a = n % 100;
                    const std::int64_t b = n % 10;
                    return std::to_string(n) + " " + (a > 10 && a < 20 ? many : b == 1 ? one : (b > 1 && b < 5) ? few : many);
                }

            } // namespace

            std::string str(const json::object& o, const char* key) {
                const auto* v = o.if_contains(key);
                return v && v->is_string() ? std::string(v->as_string()) : std::string();
            }

            std::uint16_t poll(const std::string& backend_url, const std::string& camera_id, json::object& reason) {
                std::string body;
                std::string err;
                if (!http_get(backend_url, "/api/neural/status", body, err)) {
                    reason = json::object{ {"code", "backend_unavailable"}, {"error", err} };
                    return 0;
                }
                boost::system::error_code ec;
                const json::value parsed = json::parse(body, ec);
                if (ec) {
                    reason = json::object{ {"code", "backend_unavailable"}, {"error", "invalid json"} };
                    return 0;
                }
                return evaluate(parsed, camera_id, reason);
            }

            std::uint16_t evaluate(const json::value& body, const std::string& camera_id, json::object& reason) {
                const json::array* devices = nullptr;
                if (const auto* o = body.if_object()) {
                    if (const auto* data = o->if_contains("data"); data && data->is_object()) {
                        if (const auto* list = data->as_object().if_contains("devices"); list && list->is_array()) {
                            devices = &list->as_array();
                        }
                    }
                }
                if (!devices) {
                    reason = json::object{ {"code", "backend_unavailable"}, {"error", "no data.devices"} };
                    return 0;
                }
                if (devices->empty()) {
                    reason = json::object{ {"code", "no_devices"} };
                    return 0;
                }

                // Для одной камеры неисправность чужих плат и слотов не в счёт; первая — причина, если камеры нет
                json::object fault;
                std::size_t slots_total = 0;
                std::size_t tiles_total = 0;
                for (const auto& dv : *devices) {
                    const json::object empty;
                    const json::object& d = dv.is_object() ? dv.as_object() : empty;
                    std::string device = str(d, "device_name");
                    if (device.empty()) {
                        device = str(d, "device_id");
                    }
                    const std::string state = str(d, "state");
                    if (state != "ok") {
                        reason = json::object{ {"code", state == "no_module" ? "no_module" : "device_offline"}, {"device", device} };
                        if (camera_id.empty()) {
                            return 0;
                        }
                        if (fault.empty()) {
                            fault = reason;
                        }
                        continue;
                    }
                    const auto* slots = d.if_contains("slots");
                    if (!slots || !slots->is_array() || slots->as_array().empty()) {
                        reason = json::object{ {"code", "no_slots"}, {"device", device} };
                        if (camera_id.empty()) {
                            return 0;
                        }
                        if (fault.empty()) {
                            fault = reason;
                        }
                        continue;
                    }
                    for (const auto& sv : slots->as_array()) {
                        const json::object& s = sv.is_object() ? sv.as_object() : empty;
                        const std::string stream = str(s, "stream_id");
                        const auto* running = s.if_contains("running");
                        const bool is_running = running && running->is_bool() && running->as_bool();
                        const auto* tiles = s.if_contains("tiles");
                        const bool has_tiles = tiles && tiles->is_array() && !tiles->as_array().empty();

                        if (!camera_id.empty()) {
                            if (!has_tiles) {
                                continue;
                            }
                            for (const auto& tv : tiles->as_array()) {
                                const json::object& t = tv.is_object() ? tv.as_object() : empty;
                                if (str(t, "camera") != camera_id) {
                                    continue;
                                }
                                if (!is_running) {
                                    reason = json::object{ {"code", "slot_stopped"}, {"device", device}, {"stream", stream}, {"error", str(s, "error")} };
                                    return 0;
                                }
                                const std::string tile = str(t, "state");
                                if (tile != "ok") {
                                    reason = json::object{ {"code", "tile_fault"}, {"device", device}, {"stream", stream},
                                        {"camera", camera_id}, {"tile_state", tile} };
                                    return 0;
                                }
                                reason = json::object{ {"code", "ok"}, {"device", device}, {"stream", stream}, {"camera", camera_id} };
                                return 1;
                            }
                            continue;
                        }

                        if (!is_running) {
                            reason = json::object{ {"code", "slot_stopped"}, {"device", device}, {"stream", stream}, {"error", str(s, "error")} };
                            return 0;
                        }
                        if (!has_tiles) {
                            reason = json::object{ {"code", "no_tiles"}, {"device", device}, {"stream", stream} };
                            return 0;
                        }
                        for (const auto& tv : tiles->as_array()) {
                            const json::object& t = tv.is_object() ? tv.as_object() : empty;
                            const std::string tile = str(t, "state");
                            if (tile != "ok") {
                                reason = json::object{ {"code", "tile_fault"}, {"device", device}, {"stream", stream},
                                    {"camera", str(t, "camera")}, {"tile_state", tile} };
                                return 0;
                            }
                        }
                        ++slots_total;
                        tiles_total += tiles->as_array().size();
                    }
                }
                if (!camera_id.empty()) {
                    reason = fault.empty() ? json::object{ {"code", "camera_missing"}, {"camera", camera_id} } : fault;
                    return 0;
                }
                reason = json::object{ {"code", "ok"}, {"devices", devices->size()}, {"slots", slots_total}, {"tiles", tiles_total} };
                return 1;
            }

            std::vector<std::string> reason_parts(const json::object& r) {
                const std::string code = str(r, "code");
                std::string dev = str(r, "device");
                if (dev.empty()) {
                    dev = "—";
                }
                if (code == "ok") {
                    if (!str(r, "camera").empty()) {
                        return { dev, "камера " + str(r, "camera") };
                    }
                    return { plural(num(r, "devices"), "плата", "платы", "плат"),
                        plural(num(r, "slots"), "слот", "слота", "слотов"),
                        plural(num(r, "tiles"), "камера", "камеры", "камер") };
                }
                if (code == "unknown") return { "не проверялось" };
                if (code == "backend_unavailable") return { "бэкенд недоступен" };
                if (code == "no_devices") return { "нет плат техзрения" };
                if (code == "device_offline") return { dev + " не в сети" };
                if (code == "no_module") return { dev, "нет модуля техзрения" };
                if (code == "no_slots") return { dev, "слотов нет" };
                if (code == "slot_stopped") return { dev, "слот " + str(r, "stream") + " остановлен" };
                if (code == "no_tiles") return { dev, "слот " + str(r, "stream") + " без камер" };
                if (code == "camera_missing") return { "камера " + str(r, "camera"), "нет в слотах техзрения" };
                if (code == "tile_fault") {
                    const std::string tile = str(r, "tile_state");
                    return { dev, "камера " + str(r, "camera"),
                        tile == "no_camera" ? "камеры нет в хранилище" : tile == "stalled" ? "кадр замёрз" : tile };
                }
                return { code };
            }

        } // namespace neural_health
    } // namespace gateway
} // namespace varan
