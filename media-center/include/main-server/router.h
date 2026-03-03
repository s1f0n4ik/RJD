#pragma once
#include <boost/beast/http.hpp>
#include <functional>
#include <unordered_map>
#include <string>

namespace http = boost::beast::http;

class URouter {
public:
    using Request = http::request<http::string_body>;
    using Response = http::response<http::string_body>;
    using Handler = std::function<Response(const Request&)>;

    void add_route(http::verb method, const std::string& path, Handler handler);
    Response route(const Request& req);

private:
    std::unordered_map<std::string, Handler> m_routes;
};