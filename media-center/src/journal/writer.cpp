#include "journal/writer.h"

#include <boost/json.hpp>

#include <system_error>

namespace varan {
namespace journal {

namespace {

    // Объекты кадра в виде json
    std::string objects_to_json(const std::vector<FDetectionObject>& objs) {
        boost::json::array arr;
        for (const auto& o : objs) {
            boost::json::object d;
            d["cid"] = o.cid;
            d["cf"] = o.cf;
            d["state"] = o.state;
            boost::json::array box;
            box.emplace_back(o.box[0]);
            box.emplace_back(o.box[1]);
            box.emplace_back(o.box[2]);
            box.emplace_back(o.box[3]);
            d["box"] = std::move(box);
            arr.push_back(std::move(d));
        }
        return boost::json::serialize(arr);
    }

} // namespace

    UJournalWriter::UJournalWriter(std::filesystem::path db_path,
                                   std::filesystem::path frames_dir,
                                   ULogger::ELoggerLevel level)
        : db::AAsyncWriter<FEntry>(std::move(db_path), "JournalWriter", level)
        , m_frames_dir(std::move(frames_dir))
    {
    }

    UJournalWriter::~UJournalWriter() {
        stop();
    }

    bool UJournalWriter::prepare() {
        std::error_code ec;
        std::filesystem::create_directories(m_frames_dir, ec);
        if (ec) {
            logger().error("cannot create " + m_frames_dir.string() + ": " + ec.message());
        }
        return true;
    }

    bool UJournalWriter::ensure_schema() {
        // config_id хранится на записи: id классов (cid) осмысленны только внутри
        // своей конфигурации, поэтому читатель журнала резолвит их по config_id.
        static const char* kSchema =
            "CREATE TABLE IF NOT EXISTS detections("
            "  id INTEGER PRIMARY KEY,"
            "  ts INTEGER NOT NULL,"
            "  camera_id TEXT NOT NULL,"
            "  config_id TEXT,"
            "  lat REAL, lon REAL, alt REAL, speed REAL, course REAL,"
            "  gps_valid INTEGER NOT NULL DEFAULT 0,"
            "  width INTEGER, height INTEGER,"
            // Пусто — кадр потерян при переполнении очереди, запись всё равно есть.
            "  image_path TEXT,"
            "  track_id INTEGER,"
            "  event TEXT,"
            "  dets_json TEXT NOT NULL,"
            "  verdict TEXT NOT NULL DEFAULT 'unverified',"
            "  verdict_note TEXT,"
            "  verdict_at INTEGER"
            ");"
            "CREATE TABLE IF NOT EXISTS detection_objects("
            "  det_id INTEGER NOT NULL,"
            "  cid INTEGER, cf REAL,"
            "  state TEXT"   // tentative / confirmed / lost
            ");"
            "CREATE INDEX IF NOT EXISTS idx_det_ts ON detections(ts);"
            "CREATE INDEX IF NOT EXISTS idx_det_geo ON detections(lat, lon);"
            "CREATE INDEX IF NOT EXISTS idx_det_verdict ON detections(verdict);"
            "CREATE INDEX IF NOT EXISTS idx_obj_cid ON detection_objects(cid);"
            "CREATE INDEX IF NOT EXISTS idx_obj_det ON detection_objects(det_id);";

        if (!db().exec(kSchema, "schema")) return false;

        // Мягкая миграция БД, созданной прежней версией: state добавлен позже
        db().add_column("detection_objects", "state", "TEXT");
        return true;
    }

    void UJournalWriter::on_started() {
        logger().info("started: db=" + db_path().string() +
            " frames=" + m_frames_dir.string() +
            " rows=" + std::to_string(db().row_count("detections")));
    }

    FSlotJournal UJournalWriter::slot_journal() {
        return FSlotJournal{
            m_frames_dir,
            [this](FEntry e) { enqueue(std::move(e)); },
        };
    }

    bool UJournalWriter::write_one(const FEntry& e) {
        if (!db().is_open()) return false;

        db::UTransaction tx(db());

        db::UStatement insert(db(),
            "INSERT INTO detections("
            "ts,camera_id,config_id,lat,lon,alt,speed,course,gps_valid,"
            "width,height,image_path,track_id,event,dets_json) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);");

        if (!insert.ok()) {
            logger().error("prepare detections: " + db().error());
            return false;
        }

        insert.bind(e.ts).bind(e.camera_id).bind(e.config_id);
        if (e.gps_valid) {
            insert.bind(e.lat).bind(e.lon).bind(e.alt).bind(e.speed).bind(e.course);
        }
        else {
            insert.bind_null().bind_null().bind_null().bind_null().bind_null();
        }
        insert.bind(e.gps_valid).bind(e.width).bind(e.height);
        // Пустой путь — кадр потерян, пишем NULL вместо пустой строки.
        insert.bind_text_or_null(e.image_path);
        if (e.track_id) insert.bind(*e.track_id);
        else            insert.bind_null();
        insert.bind(e.event).bind(objects_to_json(e.objects));

        if (!insert.step_done()) {
            logger().error("insert detections: " + db().error());
            return false;
        }

        const std::int64_t det_id = db().last_insert_rowid();

        // Объекты кадра — отдельными строками для индексируемого фильтра по id класса.
        db::UStatement objects(db(),
            "INSERT INTO detection_objects(det_id,cid,cf,state) VALUES(?,?,?,?);");
        if (objects.ok()) {
            for (const auto& o : e.objects) {
                objects.bind(det_id).bind(o.cid).bind(o.cf).bind(o.state);
                if (!objects.step_done()) {
                    logger().warn("insert object: " + db().error());
                }
                objects.reset();
            }
        }

        if (!tx.commit()) return false;

        logger().info("row written: id=" + std::to_string(det_id) +
            " camera=" + e.camera_id +
            " objects=" + std::to_string(e.objects.size()) +
            (e.image_path.empty() ? " image=<dropped>" : " image=" + e.image_path));
        return true;
    }

} // namespace journal
} // namespace varan
