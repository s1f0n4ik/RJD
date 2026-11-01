#include "gateway/modules/websocket/client.h"

#include <cstdio>
#include <cstdlib>

#define CHECK(value) do { if (!(value)) { std::fprintf(stderr, "FAIL %d: %s\n", __LINE__, #value); std::exit(1); } } while (0)

int main() {
    namespace asio = boost::asio;
    using tcp = asio::ip::tcp;
    asio::io_context context;
    tcp::acceptor listener(context, tcp::endpoint(tcp::v4(), 0));
    listener.non_blocking(true);
    auto client = std::make_shared<varan::gateway::UWebSocketClient>(context, "localhost",
        std::to_string(listener.local_endpoint().port()), "/", "stop-check");
    client->run();
    const auto stopped = client->stop();
    context.run();
    CHECK(stopped.wait_for(std::chrono::seconds(0)) == std::future_status::ready);
    CHECK(!client->connected());
    tcp::socket incoming(context);
    boost::system::error_code error;
    listener.accept(incoming, error);
    CHECK(error == asio::error::would_block || error == asio::error::try_again);
    std::puts("websocket-stop-check: OK");
}
