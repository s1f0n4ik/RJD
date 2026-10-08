#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "core/platform.h"
#include "gateway/frame.h"
#include "neural/tracker/tracking-types.h"
#include "logger.h"

namespace varan {
namespace detection {

    // Событие трека для мастера обнаружений
    struct FTrackRecord {
        std::int64_t track_id = 0; // 0 — трек ещё не подтверждён
        neural::ETrackEvent event = neural::ETrackEvent::CREATED;
        gateway::FGatewayDetection detection;
    };

    // События треков одной камеры за такт слота
    struct FPacket {
        std::string video_id;
        std::string config_id;
        std::string camera_id;
        gateway::FGatewayTimeGps time_gps;
        int width = 0;
        int height = 0;
        std::vector<FTrackRecord> tracks;
        std::uint64_t image_id = 0; // 0 — снимок не брался
    };

    // Клиент мастера обнаружений (gRPC DetectionIngress.Stream): очередь в памяти до подтверждения, досылка после обрыва
    class UDetectionClient {
    public:
        UDetectionClient(std::string host, std::string port, FDeviceInfo device,
            ULogger::ELoggerLevel level = ULogger::ELoggerLevel::INFO);
        ~UDetectionClient();

        UDetectionClient(const UDetectionClient&) = delete;
        UDetectionClient& operator=(const UDetectionClient&) = delete;

        void start();
        void stop();

        void send_packet(FPacket packet);
        // ID снимка для пакета; сам снимок приходит позже через send_image
        std::uint64_t reserve_image_id() { return m_next_image_id.fetch_add(1); }
        void send_image(std::uint64_t id, std::string jpeg, int width, int height);

    private:
        struct FItem {
            bool image = false;
            std::uint64_t id = 0;
            FPacket packet;
            std::string jpeg;
            int width = 0;
            int height = 0;
        };

        void push(FItem item);
        void worker_loop();
        // Под m_mutex: убирает подтверждённое мастером из записанного в поток
        void confirm(bool image, std::uint64_t id);
        // Под m_mutex: при переполнении убирает старые снимки, затем старые пакеты
        void trim();
        void erase_at(std::size_t index);
        // Под m_mutex: состояние очереди в лог не чаще раза в 10 с, если оно изменилось
        void log_stats();

        std::string m_host;
        std::string m_port;
        FDeviceInfo m_device;
        ULogger m_logger;

        // Неподтверждённое мастером в порядке отправки
        std::deque<FItem> m_queue;
        // Первый элемент очереди, ещё не записанный в текущий поток
        std::size_t m_unsent = 0;
        std::size_t m_packets = 0;
        std::size_t m_image_bytes = 0;
        std::uint64_t m_next_packet_id = 1;
        std::atomic<std::uint64_t> m_next_image_id{ 1 };
        std::uint64_t m_sent = 0;
        std::uint64_t m_confirmed = 0;
        std::uint64_t m_dropped_packets = 0;
        std::uint64_t m_dropped_images = 0;
        std::string m_logged_stats;
        std::chrono::steady_clock::time_point m_logged_at;
        // Поток к мастеру оборвался, читатель подтверждений вышел
        bool m_broken = false;
        std::mutex m_mutex;
        std::condition_variable m_cv;

        std::thread m_thread;
        std::atomic_bool m_running{ false };
    };

} // namespace detection
} // namespace varan
