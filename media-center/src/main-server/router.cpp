#include "main-server/router.h"

void URouter::add_route(http::verb method, const std::string& path, Handler handler) 
{
    std::string key = std::to_string(static_cast<int>(method)) + ":" + path;
    m_routes[key] = std::move(handler);
}

URouter::Response URouter::route(const Request& req) 
{
    std::string_view target = req.target();

    // Отделяем path от query
    std::string_view path = target;
    if (auto pos = target.find('?'); pos != std::string_view::npos) {
        path = target.substr(0, pos);
    }

    std::string key =
        std::to_string(static_cast<int>(req.method())) +
        ":" +
        std::string(path);

    auto it = m_routes.find(key);
    if (it != m_routes.end()) {
        return it->second(req);
    }

    Response res{ http::status::not_found, req.version() };
    res.set(http::field::content_type, "application/json");
    res.body() = R"({"error":"Not found"})";
    res.prepare_payload();
    return res;
}