#include "gateway/core/http-server.h"

#include <cstdio>
#include <cstdlib>

int main() {
    namespace asio = boost::asio;
    using tcp = asio::ip::tcp;
    asio::io_context context;
    tcp::acceptor occupied(context, tcp::endpoint(tcp::v4(), 0));
    try {
        auto listener = std::make_shared<varan::gateway::UListener>(context, occupied.local_endpoint(),
            std::make_shared<varan::gateway::URouter>());
    }
    catch (const boost::system::system_error&) {
        std::puts("gateway listener-check: OK");
        return 0;
    }
    std::fputs("FAIL: occupied REST port accepted\n", stderr);
    return 1;
}
