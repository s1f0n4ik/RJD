#include "detection/client.h"

#include <algorithm>

#include <grpcpp/grpcpp.h>

#include "detection-ingress.grpc.pb.h"

namespace varan {
namespace detection {

    namespace {

        constexpr int MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
        constexpr std::size_t MAX_PACKETS = 50000;
        constexpr std::size_t MAX_IMAGE_BYTES = 256u * 1024 * 1024;

        rpc::TrackEvent to_proto(neural::ETrackEvent event) {
            switch (event) {
                case neural::ETrackEvent::CREATED: return rpc::TRACK_EVENT_CREATED;
                case neural::ETrackEvent::CONFIRMED: return rpc::TRACK_EVENT_CONFIRMED;
                case neural::ETrackEvent::UPDATED: return rpc::TRACK_EVENT_UPDATED;
                case neural::ETrackEvent::LOST: return rpc::TRACK_EVENT_LOST;
                case neural::ETrackEvent::RECOVERED: return rpc::TRACK_EVENT_RECOVERED;
                case neural::ETrackEvent::REMOVED: return rpc::TRACK_EVENT_REMOVED;
            }
            return rpc::TRACK_EVENT_UNSPECIFIED;
        }

        void fill_packet(rpc::Packet& out, std::uint64_t id, const FPacket& p, const FDeviceInfo& device) {
            out.set_id(id);
            out.set_device_id(device.device_id);
            out.set_session(device.session_id);
            out.set_video_id(p.video_id);
            out.set_config_id(p.config_id);
            out.set_camera_id(p.camera_id);
            out.set_ts(p.time_gps.unix_ms);
            out.set_sadko_time(p.time_gps.sadko_time);

            auto* gps = out.mutable_gps();
            gps->set_valid(p.time_gps.valid);
            gps->set_lat(p.time_gps.lat);
            gps->set_lon(p.time_gps.lon);
            gps->set_alt(p.time_gps.alt);
            gps->set_sats(p.time_gps.sats);
            gps->set_speed(p.time_gps.speed);
            gps->set_course(p.time_gps.course);

            out.set_width(p.width);
            out.set_height(p.height);
            for (const auto& t : p.tracks) {
                auto* r = out.add_tracks();
                r->set_track_id(static_cast<std::uint64_t>(std::max<std::int64_t>(t.track_id, 0)));
                r->set_event(to_proto(t.event));
                r->set_class_id(t.detection.cid);
                r->set_class_name(t.detection.cls);
                r->set_superclass(t.detection.scls.value_or(""));
                r->set_confidence(static_cast<float>(t.detection.cf));
                for (int v : t.detection.box) r->add_box(v);
            }
            out.set_image_id(p.image_id);
        }

    } // namespace

    UDetectionClient::UDetectionClient(std::string host, std::string port, FDeviceInfo device, ULogger::ELoggerLevel level)
        : m_host(std::move(host))
        , m_port(std::move(port))
        , m_device(std::move(device))
        , m_logger("DetectionClient", level)
    {}

    UDetectionClient::~UDetectionClient() {
        stop();
    }

    void UDetectionClient::start() {
        if (m_running.exchange(true)) return;
        m_logged_at = std::chrono::steady_clock::now();
        m_thread = std::thread(&UDetectionClient::worker_loop, this);
    }

    void UDetectionClient::stop() {
        if (!m_running.exchange(false)) return;
        m_cv.notify_all();
        if (m_thread.joinable()) m_thread.join();

        std::lock_guard<std::mutex> lk(m_mutex);
        if (!m_queue.empty())
            m_logger.warn("stopped with " + std::to_string(m_queue.size()) + " unconfirmed item(s)");
        m_queue.clear();
    }

    void UDetectionClient::send_packet(FPacket packet) {
        FItem item;
        item.packet = std::move(packet);
        push(std::move(item));
    }

    void UDetectionClient::send_image(std::uint64_t id, std::string jpeg, int width, int height) {
        FItem item;
        item.image = true;
        item.id = id;
        item.jpeg = std::move(jpeg);
        item.width = width;
        item.height = height;
        push(std::move(item));
    }

    void UDetectionClient::push(FItem item) {
        if (!m_running.load()) return;
        {
            std::lock_guard<std::mutex> lk(m_mutex);
            if (item.image) {
                m_image_bytes += item.jpeg.size();
            }
            else {
                item.id = m_next_packet_id++;
                ++m_packets;
            }
            m_queue.push_back(std::move(item));
            trim();
        }
        m_cv.notify_all();
    }

    void UDetectionClient::confirm(bool image, std::uint64_t id) {
        for (std::size_t i = 0; i < m_unsent; ++i) {
            if (m_queue[i].image == image && m_queue[i].id == id) {
                erase_at(i);
                ++m_confirmed;
                return;
            }
        }
    }

    void UDetectionClient::trim() {
        for (std::size_t i = 0; m_image_bytes > MAX_IMAGE_BYTES && i < m_queue.size();) {
            if (m_queue[i].image) {
                erase_at(i);
                ++m_dropped_images;
            }
            else ++i;
        }
        for (std::size_t i = 0; m_packets > MAX_PACKETS && i < m_queue.size();) {
            if (!m_queue[i].image) {
                erase_at(i);
                ++m_dropped_packets;
            }
            else ++i;
        }
    }

    void UDetectionClient::erase_at(std::size_t index) {
        const auto it = m_queue.begin() + static_cast<std::ptrdiff_t>(index);
        if (it->image) m_image_bytes -= it->jpeg.size();
        else --m_packets;
        m_queue.erase(it);
        if (index < m_unsent) --m_unsent;
    }

    void UDetectionClient::log_stats() {
        const auto now = std::chrono::steady_clock::now();
        if (now - m_logged_at < std::chrono::seconds(10)) return;

        const std::string stats = "queue " + std::to_string(m_packets) + " packet(s), "
            + std::to_string(m_queue.size() - m_packets) + " image(s) " + std::to_string(m_image_bytes >> 20) + " MB"
            + "; sent " + std::to_string(m_sent) + ", confirmed " + std::to_string(m_confirmed)
            + ", dropped " + std::to_string(m_dropped_packets) + " packet(s) " + std::to_string(m_dropped_images) + " image(s)";
        if (stats == m_logged_stats) return;

        m_logged_at = now;
        m_logged_stats = stats;
        m_logger.info(stats);
    }

    void UDetectionClient::worker_loop() {
        const std::string target = m_host + ":" + m_port;

        grpc::ChannelArguments args;
        args.SetMaxSendMessageSize(MAX_MESSAGE_BYTES);
        args.SetMaxReceiveMessageSize(MAX_MESSAGE_BYTES);

        int backoff_ms = 500;
        bool reported_down = false;

        while (m_running.load()) {
            auto channel = grpc::CreateCustomChannel(target, grpc::InsecureChannelCredentials(), args);
            if (channel->WaitForConnected(std::chrono::system_clock::now() + std::chrono::seconds(2))) {
                auto stub = rpc::DetectionIngress::NewStub(channel);
                grpc::ClientContext ctx;
                auto stream = stub->Stream(&ctx);

                std::size_t pending = 0;
                {
                    std::lock_guard<std::mutex> lk(m_mutex);
                    m_unsent = 0;
                    m_broken = false;
                    pending = m_queue.size();
                }
                m_logger.info("connected to " + target + ", resending " + std::to_string(pending) + " unconfirmed item(s)");
                reported_down = false;

                std::atomic_bool confirmed_any{ false };
                std::thread reader([&] {
                    rpc::Ack ack;
                    while (stream->Read(&ack)) {
                        std::lock_guard<std::mutex> lk(m_mutex);
                        for (const auto id : ack.packet_ids()) confirm(false, id);
                        for (const auto id : ack.image_ids()) confirm(true, id);
                        confirmed_any.store(true);
                    }
                    std::lock_guard<std::mutex> lk(m_mutex);
                    m_broken = true;
                    m_cv.notify_all();
                });

                while (true) {
                    rpc::DeviceMessage msg;
                    {
                        std::unique_lock<std::mutex> lk(m_mutex);
                        m_cv.wait_for(lk, std::chrono::seconds(10),
                            [&] { return !m_running.load() || m_broken || m_unsent < m_queue.size(); });
                        log_stats();
                        if (!m_running.load() || m_broken) break;
                        if (m_unsent >= m_queue.size()) continue;

                        const FItem& item = m_queue[m_unsent];
                        if (item.image) {
                            auto* image = msg.mutable_image();
                            image->set_id(item.id);
                            image->set_device_id(m_device.device_id);
                            image->set_session(m_device.session_id);
                            image->set_jpeg(item.jpeg);
                            image->set_width(item.width);
                            image->set_height(item.height);
                        }
                        else {
                            fill_packet(*msg.mutable_packet(), item.id, item.packet, m_device);
                        }
                        ++m_unsent;
                        ++m_sent;
                    }
                    if (!stream->Write(msg)) break;
                }

                stream->WritesDone();
                ctx.TryCancel();
                reader.join();
                const grpc::Status status = stream->Finish();
                if (!m_running.load()) break;

                if (confirmed_any.load()) backoff_ms = 500;
                {
                    std::lock_guard<std::mutex> lk(m_mutex);
                    pending = m_queue.size();
                }
                m_logger.warn("stream to " + target + " lost" + (status.ok() ? "" : ": " + status.error_message())
                    + ", unconfirmed " + std::to_string(pending) + ", reconnect in " + std::to_string(backoff_ms) + " ms");
            }
            else if (!reported_down) {
                m_logger.warn("master " + target + " unreachable, retrying");
                reported_down = true;
            }

            std::unique_lock<std::mutex> lk(m_mutex);
            log_stats();
            m_cv.wait_for(lk, std::chrono::milliseconds(backoff_ms), [&] { return !m_running.load(); });
            backoff_ms = std::min(backoff_ms * 2, 5000);
        }

        m_logger.info("worker stopped");
    }

} // namespace detection
} // namespace varan
