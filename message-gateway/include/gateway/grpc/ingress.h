#pragma once

#include <memory>
#include <thread>
#include <cstdint>
#include <cstddef>

#include "gateway/core/frame-sink.h"

namespace grpc {
    class Server;
    class Service;
}

namespace varan {
    namespace gateway {

        // gRPC-приёмник кадров. Поднимает сервер FrameIngress на своём порту и
        // крутит его в отдельном потоке. Полученные кадры отдаёт в IFrameSink.
        class UGrpcIngress {
        public:
            UGrpcIngress(IFrameSink& sink, std::uint16_t port,
                std::size_t max_message_bytes = 64ull * 1024 * 1024);
            ~UGrpcIngress();

            void start();
            void stop();

        private:
            IFrameSink& m_sink;
            std::uint16_t m_port;
            std::size_t m_max_message_bytes;

            std::unique_ptr<grpc::Service> m_service;
            std::unique_ptr<grpc::Server> m_server;
            std::thread m_thread;
        };

    } // namespace gateway
} // namespace varan
