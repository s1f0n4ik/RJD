#include "video_pipeline.h"
#include "archive/segment-writer.h"
#include "core/paths.h"

#include <boost/json/src.hpp>
#include <sqlite3.h>
#include <unistd.h>

#define CHECK(value) do { if (!(value)) { std::fprintf(stderr, "FAIL %d: %s\n", __LINE__, #value); std::exit(1); } } while (0)

class UTestRecordPipeline final : public UCameraStreamPipeline {
public:
    UTestRecordPipeline(const FPipelineConfig& config, std::shared_ptr<varan::archive::USegmentWriter> writer)
        : UCameraStreamPipeline(config, std::make_unique<ULogger>("record-check", ULogger::ELoggerLevel::ERROR), nullptr),
          m_writer(std::move(writer)) { set_segment_writer(m_writer); }

    bool initialize() override {
        GError* error = nullptr;
        const auto launch = "videotestsrc is-live=true ! video/x-raw,width=160,height=120,framerate=25/1 ! "
            "x264enc tune=zerolatency key-int-max=25 ! tee name=t "
            "t. ! queue ! fakesink sync=false async=false "
            "t. ! queue ! splitmuxsink max-size-time=1000000000 async-finalize=true muxer-factory=mp4mux location="
            + (m_parameters.record_path / "segment-%02d.mp4").string();
        m_pipeline = gst_parse_launch(launch.c_str(), &error);
        CHECK(!error && m_pipeline);
        m_bus_watch = setup_bus_watch(m_pipeline);
        m_has_initialized = true;
        m_status = EPipelineStatus::INITIALIZED;
        return true;
    }

    std::atomic_int opened{0}, closed{0};

protected:
    void on_bus_message(GstMessage* message) override {
        if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ELEMENT) {
            const auto* structure = gst_message_get_structure(message);
            if (structure && gst_structure_has_name(structure, "splitmuxsink-fragment-opened")) {
                varan::archive::FSegmentEvent event;
                event.kind = varan::archive::FSegmentEvent::EKind::OPENED;
                event.path = gst_structure_get_string(structure, "location");
                event.camera_id = "test";
                event.stream_key = "stream";
                event.mono_ms = 1000;
                event.wall_ms = 1800000000000;
                m_writer->enqueue(std::move(event));
                ++opened;
            }
            if (structure && gst_structure_has_name(structure, "splitmuxsink-fragment-closed")) ++closed;
        }
        UCameraStreamPipeline::on_bus_message(message);
    }

private:
    std::shared_ptr<varan::archive::USegmentWriter> m_writer;
};

int main(int argc, char** argv) {
    gst_init(&argc, &argv);
    char directory[] = "/tmp/record-stop-check-XXXXXX";
    CHECK(mkdtemp(directory));
    const auto root = std::filesystem::path(directory);
    varan::init_paths(root, root);
    const auto db_path = root / "index.db";
    auto writer = std::make_shared<varan::archive::USegmentWriter>(db_path, ULogger::ELoggerLevel::ERROR);
    CHECK(writer->start());
    auto* loop = g_main_loop_new(nullptr, false);
    std::thread bus([&] { g_main_loop_run(loop); });
    {
        FPipelineConfig config;
        config.camera_name = "test";
        config.name = "stream";
        config.purposes.record = true;
        config.record_path = root;
        UTestRecordPipeline pipeline(config, writer);
        CHECK(pipeline.initialize() && pipeline.start());
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
        while (pipeline.opened < 2 && std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        CHECK(pipeline.opened >= 2);
        CHECK(pipeline.prepare_stop().empty());
        CHECK(pipeline.opened == pipeline.closed);
        CHECK(pipeline.prepare_stop().empty());
        CHECK(pipeline.teardown());
        CHECK(writer->flush());
        sqlite3* database = nullptr;
        sqlite3_stmt* statement = nullptr;
        CHECK(sqlite3_open(db_path.c_str(), &database) == SQLITE_OK);
        CHECK(sqlite3_prepare_v2(database, "SELECT COUNT(*), SUM(closed), MIN(size_bytes) FROM segments", -1, &statement, nullptr) == SQLITE_OK);
        CHECK(sqlite3_step(statement) == SQLITE_ROW);
        CHECK(sqlite3_column_int(statement, 0) == pipeline.opened);
        CHECK(sqlite3_column_int(statement, 1) == pipeline.opened);
        CHECK(sqlite3_column_int64(statement, 2) > 0);
        sqlite3_finalize(statement);
        sqlite3_close(database);
    }
    g_main_loop_quit(loop);
    bus.join();
    g_main_loop_unref(loop);
    writer->stop();
    std::puts("record-stop-check: OK");
}
