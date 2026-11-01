#include <boost/json/src.hpp>
#include <cstdio>
#include <cstdlib>
#include <future>
#include <unistd.h>

#include "core/paths.h"
#include "core/websocket-handler.h"
#include "main-server/config-controller.h"

namespace json = boost::json;
namespace http = boost::beast::http;
using namespace varan;

#define CHECK(value) do { if (!(value)) { std::fprintf(stderr, "FAIL %d: %s\n", __LINE__, #value); std::exit(1); } } while (0)

class UTestSignaling final : public UWebSocketHandler {
public:
    UTestSignaling() : UWebSocketHandler("127.0.0.1", "1", ULogger::ELoggerLevel::ERROR) {}
    ~UTestSignaling() override { stop_websocket_client(); }
    void start() { start_websocket_client("/test", "test"); }
    void stop() { stop_websocket_client(); }
    void check_dispatch() {
        std::promise<void> ready;
        auto future = ready.get_future();
        boost::asio::post(m_io_context, [&] { ready.set_value(); });
        CHECK(future.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    }
private:
    void on_signaling_message(const std::string&) override {}
};

int main() {
    char directory[] = "/tmp/config-hold-check-XXXXXX";
    CHECK(mkdtemp(directory));
    const auto root = std::filesystem::path(directory);
    init_paths(root, root);
    auto config = std::make_shared<UMachineConfig>(ULogger::ELoggerLevel::ERROR);
    int applications = 0;
    config->register_part("cameras", [&](const json::value&) { ++applications; return std::string(); });
    config->register_part("neural", [](const json::value&) { return std::string(); });
    UConfigController controller(config);
    const auto request = [](const json::object& body) {
        http::request<http::string_body> req{http::verb::put, "/config", 11};
        req.body() = json::serialize(body);
        return req;
    };
    const auto status = [&] {
        return json::parse(controller.get_hold(request({})).body()).as_object().at("data").as_object();
    };
    CHECK(config->allows_start("cameras"));
    CHECK(config->check_command({}, true).empty());
    CHECK(status().at("available").as_array().size() == 2);
    json::object package{{"revision", "old"}, {"parts", json::object{{"cameras", json::object{}}}}};
    CHECK(controller.put_config(request(package)).result() == http::status::ok);
    json::object hold{{"transition_id", "one"}, {"previous_transition_id", ""}, {"held", true}};
    CHECK(controller.put_hold(request(hold)).result() == http::status::ok);
    CHECK(status().at("held").as_bool() && !config->allows_start("cameras"));
    CHECK(!config->check_command({}, true).empty());
    CHECK(!config->check_command({}, false).empty());
    CHECK(!config->check_command({{"transition_id", "old"}}, false).empty());
    CHECK(config->check_command({{"transition_id", "one"}}, false).empty());
    CHECK(!config->check_command({{"transition_id", "one"}, {"revision", "new"}}, true).empty());
    UMachineConfig stopped(ULogger::ELoggerLevel::ERROR);
    CHECK(!stopped.allows_start("cameras"));
    CHECK(stopped.hold_status().at("transition_id") == "one");
    CHECK(controller.put_config(request(package)).result() != http::status::ok);
    CHECK(applications == 1);
    package["revision"] = "new";
    package["transition_id"] = "one";
    package["parts"] = json::object{{"cameras", json::object{{"changed", true}}}};
    CHECK(controller.put_config(request(package)).result() == http::status::ok);
    CHECK(applications == 2 && status().at("revision") == "new");
    CHECK(status().at("held").as_bool() && !config->allows_start("cameras"));
    json::object release{{"transition_id", "one"}, {"revision", "new"}, {"held", false}, {"modules", json::array{"cameras"}}};
    CHECK(config->check_command(release, true).empty());
    auto wrong = release;
    wrong["revision"] = "old";
    CHECK(controller.put_hold(request(wrong)).result() == http::status::conflict);
    wrong = release;
    wrong["modules"] = json::array{"unknown"};
    CHECK(controller.put_hold(request(wrong)).result() == http::status::conflict);
    CHECK(controller.put_hold(request(release)).result() == http::status::ok);
    CHECK(config->allows_start("cameras") && !config->allows_start("neural"));
    CHECK(!config->check_command(release, true).empty());
    CHECK(controller.put_hold(request(hold)).result() == http::status::conflict);
    UMachineConfig running(ULogger::ELoggerLevel::ERROR);
    CHECK(running.allows_start("cameras") && !running.allows_start("neural"));
    hold["transition_id"] = "two";
    CHECK(controller.put_hold(request(hold)).result() == http::status::conflict);
    hold["previous_transition_id"] = "one";
    CHECK(controller.put_hold(request(hold)).result() == http::status::ok);
    CHECK(!config->allows_start("cameras"));
    const auto hold_path = paths().config.applied.parent_path() / "hold.json";
    CHECK(write_durable(hold_path, "invalid").empty());
    UMachineConfig corrupt(ULogger::ELoggerLevel::ERROR);
    CHECK(!corrupt.allows_start("cameras"));
    CHECK(!corrupt.check_command({}, true).empty());
    CHECK(!corrupt.check_command({{"transition_id", ""}, {"revision", "new"}}, true).empty());
    CHECK(!corrupt.apply({{"revision", "unauthorized"}}).ok);
    CHECK(!corrupt.apply({{"revision", "unauthorized"}, {"transition_id", ""}}).ok);
    std::filesystem::remove(hold_path);
    std::filesystem::create_directory(hold_path);
    CHECK(controller.put_hold(request(hold)).result() == http::status::conflict);
    CHECK(!config->allows_start("cameras"));
    release["transition_id"] = "two";
    CHECK(controller.put_hold(request(release)).result() == http::status::conflict);
    CHECK(config->hold_status().at("held").as_bool());
    std::filesystem::remove(hold_path);
    CHECK(controller.put_hold(request(hold)).result() == http::status::ok);
    CHECK(controller.put_hold(request(release)).result() == http::status::ok);
    UTestSignaling signaling;
    for (int i = 0; i < 3; ++i) {
        signaling.start();
        signaling.start();
        signaling.check_dispatch();
        signaling.stop();
        signaling.stop();
    }
    std::filesystem::remove_all(root);
    std::puts("config-hold-check: OK");
}
