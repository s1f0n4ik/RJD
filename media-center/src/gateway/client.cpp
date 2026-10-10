#include "gateway/client.h"

#include <chrono>

#include <grpcpp/grpcpp.h>

#include "frame-ingress.grpc.pb.h"

namespace varan {
namespace gateway {

    UGatewayClient::UGatewayClient(FGatewayConfig config, ULogger::ELoggerLevel level)
        : m_host(std::move(config.host))
        , m_port(std::move(config.port))
        , m_logger("GatewayClient", level)
    {}

    UGatewayClient::~UGatewayClient() {
        stop();
    }

    void UGatewayClient::start() {
        if (m_running.exchange(true)) {
            return;
        }
        m_time_thread = std::thread(&UGatewayClient::time_sync_loop, this);
    }

    void UGatewayClient::stop() {
        if (!m_running.exchange(false)) {
            return;
        }
        m_time_cv.notify_all();
        if (m_time_thread.joinable()) {
            m_time_thread.join();
        }
    }

    void UGatewayClient::set_time_callback(FGatewayTimeCallback callback) {
        m_time_callback = std::move(callback);
    }

    void UGatewayClient::time_sync_loop() {
        const std::string target = m_host + ":" + m_port;
        auto channel = grpc::CreateChannel(target, grpc::InsecureChannelCredentials());
        auto stub = rpc::FrameIngress::NewStub(channel);

        while (m_running.load()) {
            grpc::ClientContext ctx;
            ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(3));

            rpc::TimeRequest request;
            rpc::TimeReply reply;
            const grpc::Status status = stub->GetTime(&ctx, request, &reply);

            if (status.ok()) {
                if (m_time_callback) {
                    FGatewayTimeGps t;
                    t.unix_ms = reply.unix_ms();
                    // В proto поле осталось can_time: пакет неизменен
                    t.sadko_time = reply.can_time();
                    t.lat = reply.gps().lat();
                    t.lon = reply.gps().lon();
                    t.alt = reply.gps().alt();
                    t.valid = reply.gps().valid();
                    t.sats = reply.gps().sats();
                    t.speed = reply.gps().speed();
                    t.course = reply.gps().course();
                    m_time_callback(t);
                }
            }
            else {
                m_logger.warn("time sync with " + target + " failed: " + status.error_message());
            }

            std::unique_lock<std::mutex> lk(m_time_mutex);
            m_time_cv.wait_for(lk, std::chrono::seconds(10), [&] { return !m_running.load(); });
        }
    }

} // namespace gateway
} // namespace varan