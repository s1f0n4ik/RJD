#include "gateway/client.h"

#include <chrono>
#include <algorithm>

#include <grpcpp/grpcpp.h>

#include "frame-ingress.grpc.pb.h"

namespace varan {
namespace gateway {

    // Пакет proto — varan.gateway.rpc, так что rpc:: здесь ищется сразу в
    // varan::gateway и алиас не нужен (он бы конфликтовал по имени).

    namespace {

        // Максимальный размер сообщения - 64МБ
        constexpr int MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

        rpc::FrameRequest to_proto(const FGatewayFrame& f) {
            rpc::FrameRequest req;
            req.set_ver(f.ver);
            req.set_id(f.id);
            req.set_ts(f.ts);
            req.set_width(f.width);
            req.set_height(f.height);
            req.set_format(f.format);
            req.set_camera_id(f.camera_id);
            req.set_image(f.image);

            for (const auto& d : f.dets) {
                auto* pd = req.add_dets();
                pd->set_cid(d.cid);
                pd->set_cls(d.cls);
                pd->set_cf(d.cf);
                for (int v : d.box) {
                    pd->add_box(v);
                }
                if (d.scls) {
                    pd->set_scls(*d.scls);
                }
            }
            return req;
        }

    } // namespace

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
        m_thread = std::thread(&UGatewayClient::worker_loop, this);
        m_time_thread = std::thread(&UGatewayClient::time_sync_loop, this);
    }

    void UGatewayClient::stop() {
        if (!m_running.exchange(false)) {
            return;
        }
        m_cv.notify_all();
        m_time_cv.notify_all();
        if (m_thread.joinable()) {
            m_thread.join();
        }
        if (m_time_thread.joinable()) {
            m_time_thread.join();
        }
        std::lock_guard<std::mutex> lk(m_mutex);
        m_queue.clear();
    }

    void UGatewayClient::set_time_callback(FGatewayTimeCallback callback) {
        m_time_callback = std::move(callback);
    }

    void UGatewayClient::send(FGatewayFrame frame) {
        if (!m_running.load()) {
            return;
        }
        {
            std::lock_guard<std::mutex> lk(m_mutex);
            if (m_queue.size() >= m_max_queue) {
                m_queue.pop_front();
            }
            m_queue.push_back(std::move(frame));
        }
        m_cv.notify_one();
    }

    void UGatewayClient::worker_loop() {
        const std::string target = m_host + ":" + m_port;

        grpc::ChannelArguments args;
        args.SetMaxSendMessageSize(MAX_MESSAGE_BYTES);
        args.SetMaxReceiveMessageSize(MAX_MESSAGE_BYTES);

        int backoff_ms = 500;

        while (m_running.load()) {
            auto channel = grpc::CreateCustomChannel(target, grpc::InsecureChannelCredentials(), args);
            auto stub = rpc::FrameIngress::NewStub(channel);

            grpc::ClientContext ctx;
            auto stream = stub->StreamFrames(&ctx);

            m_connected.store(true);
            m_logger.info("connected to " + target);

            // Подтверждения читаем в отдельном потоке, чтобы не копить их в буфере.
            std::thread reader([&] {
                rpc::FrameReply reply;
                while (stream->Read(&reply)) {
                    if (!reply.accepted() && !reply.error().empty()) {
                        m_logger.warn("gateway rejected frame: " + reply.error());
                    }
                }
            });

            bool broken = false;
            while (m_running.load() && !broken) {
                FGatewayFrame frame;
                {
                    std::unique_lock<std::mutex> lk(m_mutex);
                    m_cv.wait(lk, [&] { return !m_queue.empty() || !m_running.load(); });
                    if (!m_running.load()) {
                        break;
                    }
                    frame = std::move(m_queue.front());
                    m_queue.pop_front();
                }

                if (!stream->Write(to_proto(frame))) {
                    broken = true;
                }
            }

            stream->WritesDone();
            ctx.TryCancel();
            if (reader.joinable()) {
                reader.join();
            }
            grpc::Status status = stream->Finish();
            m_connected.store(false);

            if (!m_running.load()) {
                break;
            }

            m_logger.warn("stream to " + target + " lost" +
                (status.ok() ? "" : ": " + status.error_message()) +
                ", reconnect in " + std::to_string(backoff_ms) + " ms");

            std::unique_lock<std::mutex> lk(m_mutex);
            m_cv.wait_for(lk, std::chrono::milliseconds(backoff_ms), [&] { return !m_running.load(); });
            lk.unlock();
            backoff_ms = std::min(backoff_ms * 2, 5000);
        }

        m_connected.store(false);
        m_logger.info("worker stopped");
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