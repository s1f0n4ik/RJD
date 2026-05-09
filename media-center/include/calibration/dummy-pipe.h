#pragma once

#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <opencv2/opencv.hpp>
#include <string>
#include <stdexcept>
#include <thread>
#include <atomic>
#include <future>
#include <memory>

#include "logger.h"

namespace varan::calibration {

    class UGstStreamer {
    public:
        explicit UGstStreamer(ULogger* logger = nullptr)
            : logger_(logger)
        {
            gst_init(nullptr, nullptr);
        }

        ~UGstStreamer() {
            stop();
        }

        // Запускает GMainLoop и pipeline в отдельных потоках.
        // Блокируется до реального перехода в PLAYING или ошибки.
        void start(const std::string& host, int port, int width, int height, int fps)
        {
            if (is_playing_.load()) {
                log_warn("start(): already running");
                return;
            }

            width_ = width;
            height_ = height;
            fps_ = fps;

            log_debug("Starting GStreamer streamer");

            // 1. Сначала запускаем GMainLoop в отдельном потоке
            main_loop_ = g_main_loop_new(nullptr, FALSE);

            loop_thread_ = std::thread([this]() {
                log_debug("GMainLoop thread started");
                g_main_loop_run(main_loop_);
                log_debug("GMainLoop thread finished");
                });

            // Ждём пока loop реально начнёт крутиться
            while (!g_main_loop_is_running(main_loop_)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }

            // 2. Promise для ожидания PLAYING из bus-watch
            //    start() блокируется здесь, bus-watch резолвит из loop_thread_
            playing_promise_ = std::make_unique<std::promise<bool>>();
            auto playing_future = playing_promise_->get_future();

            // 3. Создаём и стартуем pipeline в отдельном потоке
            //    чтобы не блокировать вызывающий поток тяжёлой инициализацией
            pipeline_thread_ = std::thread([this, host, port]() {
                log_debug("Pipeline thread started");
                try {
                    init_pipeline(host, port);
                }
                catch (const std::exception& e) {
                    log_error("Pipeline thread exception: " + std::string(e.what()));
                    // Резолвим провал если promise ещё жив
                    if (playing_promise_) {
                        try { playing_promise_->set_value(false); }
                        catch (...) {}
                    }
                }
                log_debug("Pipeline thread finished");
                });

            // 4. Ждём сигнала от bus-watch — PLAYING или ошибка
            auto status = playing_future.wait_for(std::chrono::seconds(10));
            playing_promise_.reset();

            if (status == std::future_status::timeout) {
                log_error("Timeout waiting for pipeline PLAYING");
                stop();
                throw std::runtime_error("Pipeline PLAYING timeout");
            }

            bool ok = false;
            try { ok = playing_future.get(); }
            catch (...) {}

            if (!ok) {
                log_error("Pipeline failed to reach PLAYING state");
                stop();
                throw std::runtime_error("Pipeline failed to reach PLAYING");
            }

            log_info("GStreamer streamer started successfully");
        }

        void push_frame(cv::Mat frame)
        {
            if (!appsrc_) return;

            if (!is_playing_.load(std::memory_order_acquire)) {
                log_debug("push_frame(): not playing, skip");
                return;
            }

            if (frame.empty()) {
                log_warn("push_frame(): empty frame");
                return;
            }

            // RGBA: 4 байта на пиксель
            const size_t buf_size = frame.cols * frame.rows * 4;
            GstBuffer* buffer = gst_buffer_new_allocate(nullptr, buf_size, nullptr);
            if (!buffer) {
                log_error("Failed to allocate GstBuffer");
                return;
            }

            GstMapInfo map;
            if (!gst_buffer_map(buffer, &map, GST_MAP_WRITE)) {
                log_error("Failed to map GstBuffer");
                gst_buffer_unref(buffer);
                return;
            }

            // Просто копируем — frame уже RGBA из glReadPixels
            std::memcpy(map.data, frame.data, buf_size);
            gst_buffer_unmap(buffer, &map);

            GstFlowReturn flow = gst_app_src_push_buffer(GST_APP_SRC(appsrc_), buffer);
            if (flow != GST_FLOW_OK) {
                log_warn("push_buffer failed, flow=" + std::to_string(flow));
                if (flow == GST_FLOW_FLUSHING || flow == GST_FLOW_EOS) {
                    is_playing_.store(false, std::memory_order_release);
                }
            }
            else {
                log_debug("Frame pushed successfully");
            }
        }

        void stop()
        {
            is_playing_.store(false, std::memory_order_release);

            // Завершаем pipeline
            if (appsrc_) {
                gst_app_src_end_of_stream(GST_APP_SRC(appsrc_));
            }

            if (pipeline_) {
                // Даём EOS пройти, потом переводим в NULL
                gst_element_get_state(pipeline_, nullptr, nullptr, 300 * GST_MSECOND);
                cleanup_pipeline();
            }

            // Останавливаем pipeline_thread_
            if (pipeline_thread_.joinable()) {
                pipeline_thread_.join();
            }

            // Останавливаем GMainLoop и его поток
            if (main_loop_) {
                g_main_loop_quit(main_loop_);
            }
            if (loop_thread_.joinable()) {
                loop_thread_.join();
            }
            if (main_loop_) {
                g_main_loop_unref(main_loop_);
                main_loop_ = nullptr;
            }

            log_info("GStreamer streamer stopped");
        }

    private:
        void init_pipeline(const std::string& host, int port)
        {
            log_debug("Initializing GStreamer pipeline");

            const std::string pipeline_str =
                "appsrc name=src is-live=true block=false format=time do-timestamp=true "
                "caps=video/x-raw,format=RGBA,width=" + std::to_string(width_) +
                ",height=" + std::to_string(height_) +
                ",framerate=" + std::to_string(fps_) + "/1 "
                "! queue max-size-buffers=2 leaky=downstream "
                "! videoconvert "
                "! video/x-raw,format=NV12 "
                "! mpph264enc gop=15 "
                "! rtph264pay config-interval=1 pt=96 "
                "! udpsink host=" + host +
                " port=" + std::to_string(port) + " sync=false async=false";

            GError* error = nullptr;
            pipeline_ = gst_parse_launch(pipeline_str.c_str(), &error);
            if (!pipeline_) {
                std::string err = error ? error->message : "Unknown GStreamer error";
                if (error) g_error_free(error);
                throw std::runtime_error("Failed to create pipeline: " + err);
            }

            appsrc_ = gst_bin_get_by_name(GST_BIN(pipeline_), "src");
            if (!appsrc_) {
                cleanup_pipeline();
                throw std::runtime_error("appsrc not found");
            }

            g_object_set(G_OBJECT(appsrc_),
                "max-bytes", (guint64)(width_ * height_ * 4),
                "leaky-type", 2,  // GST_APP_LEAKY_TYPE_UPSTREAM
                nullptr);

            // Bus-watch добавляем в контекст GMainLoop — он уже крутится
            GstBus* bus = gst_element_get_bus(pipeline_);
            gst_bus_add_watch(bus, &UGstStreamer::on_bus_message, this);
            gst_object_unref(bus);

            GstStateChangeReturn ret = gst_element_set_state(pipeline_, GST_STATE_PLAYING);
            if (ret == GST_STATE_CHANGE_FAILURE) {
                log_error("set_state returned FAILURE");
                cleanup_pipeline();
                throw std::runtime_error("Pipeline set_state FAILURE");
            }

            log_debug("Pipeline set to PLAYING, waiting for bus confirmation");
            // Дальше ждём в start() через future — bus-watch пришлёт результат
        }

        void cleanup_pipeline()
        {
            if (pipeline_) {
                GstBus* bus = gst_element_get_bus(pipeline_);
                if (bus) {
                    gst_bus_remove_watch(bus);
                    gst_object_unref(bus);
                }
                gst_element_set_state(pipeline_, GST_STATE_NULL);
                gst_object_unref(pipeline_);
                pipeline_ = nullptr;
            }
            if (appsrc_) {
                gst_object_unref(appsrc_);
                appsrc_ = nullptr;
            }
        }

        static gboolean on_bus_message(GstBus*, GstMessage* msg, gpointer data)
        {
            auto* self = static_cast<UGstStreamer*>(data);

            switch (GST_MESSAGE_TYPE(msg)) {
            case GST_MESSAGE_ERROR: {
                GError* err = nullptr; gchar* dbg = nullptr;
                gst_message_parse_error(msg, &err, &dbg);
                self->log_error("Bus ERROR [" + std::string(GST_OBJECT_NAME(msg->src)) +
                    "]: " + std::string(err ? err->message : "?"));
                self->log_error("Debug: " + std::string(dbg ? dbg : "none"));
                if (err) g_error_free(err);
                if (dbg) g_free(dbg);

                self->is_playing_.store(false, std::memory_order_release);
                if (self->playing_promise_) {
                    try { self->playing_promise_->set_value(false); }
                    catch (...) {}
                    self->playing_promise_.reset();
                }
                break;
            }
            case GST_MESSAGE_WARNING: {
                GError* err = nullptr; gchar* dbg = nullptr;
                gst_message_parse_warning(msg, &err, &dbg);
                self->log_warn("Bus WARNING [" + std::string(GST_OBJECT_NAME(msg->src)) +
                    "]: " + std::string(err ? err->message : "?"));
                if (err) g_error_free(err);
                if (dbg) g_free(dbg);
                break;
            }
            case GST_MESSAGE_STATE_CHANGED: {
                if (GST_MESSAGE_SRC(msg) == GST_OBJECT(self->pipeline_)) {
                    GstState old_s, new_s, pending;
                    gst_message_parse_state_changed(msg, &old_s, &new_s, &pending);
                    self->log_debug("Pipeline state: " +
                        std::string(gst_element_state_get_name(old_s)) + " -> " +
                        std::string(gst_element_state_get_name(new_s)));

                    if (new_s == GST_STATE_PLAYING) {
                        self->is_playing_.store(true, std::memory_order_release);
                        if (self->playing_promise_) {
                            try { self->playing_promise_->set_value(true); }
                            catch (...) {}
                            self->playing_promise_.reset();
                        }
                    }
                }
                break;
            }
            case GST_MESSAGE_EOS:
                self->log_warn("Bus EOS received");
                self->is_playing_.store(false, std::memory_order_release);
                break;
            default:
                break;
            }

            return TRUE;
        }

        void log_trace(const std::string& m) { if (logger_) logger_->trace(m); }
        void log_debug(const std::string& m) { if (logger_) logger_->debug(m); }
        void log_info(const std::string& m) { if (logger_) logger_->info(m); }
        void log_warn(const std::string& m) { if (logger_) logger_->warn(m); }
        void log_error(const std::string& m) { if (logger_) logger_->error(m); }

    private:
        // GMainLoop поток — обрабатывает bus-watch и GLib события
        GMainLoop* main_loop_ = nullptr;
        std::thread loop_thread_;

        // Pipeline поток — инициализирует и держит pipeline
        std::thread pipeline_thread_;

        // Promise для синхронизации start() с bus-watch
        std::unique_ptr<std::promise<bool>> playing_promise_;

        GstElement* pipeline_ = nullptr;
        GstElement* appsrc_ = nullptr;
        std::atomic<bool> is_playing_{ false };

        int width_ = 0;
        int height_ = 0;
        int fps_ = 0;

        ULogger* logger_ = nullptr;
    };

} // namespace varan::calibration