#include "journal/writer.h"

#include <sqlite3.h>

#include <boost/json.hpp>

namespace varan {
namespace journal {

namespace {

    // Объекты кадра как JSON-массив для денормализованной колонки dets_json —
    // фронт читает её одним запросом, без join'а по объектам. Только id класса,
    // confidence и бокс; семантику (имя/цвет/опасность) фронт резолвит сам.
    std::string objects_to_json(const std::vector<FDetectionObject>& objs) {
        boost::json::array arr;
        for (const auto& o : objs) {
            boost::json::object d;
            d["cid"] = o.cid;
            d["cf"] = o.cf;
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
        : m_db_path(std::move(db_path))
        , m_frames_dir(std::move(frames_dir))
        , m_logger("JournalWriter", level)
    {
    }

    UJournalWriter::~UJournalWriter() {
        stop();
    }

    bool UJournalWriter::start() {
        if (m_running.load()) return true;

        // Каталоги под базу и кадры создаём заранее — media-center пишет их на
        // том /storage, который смонтирован снаружи.
        std::error_code ec;
        std::filesystem::create_directories(m_db_path.parent_path(), ec);
        std::filesystem::create_directories(m_frames_dir, ec);

        if (sqlite3_open_v2(m_db_path.string().c_str(), &m_db,
                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr) != SQLITE_OK) {
            m_logger.error("open(" + m_db_path.string() + "): " +
                (m_db ? sqlite3_errmsg(m_db) : "no handle"));
            if (m_db) { sqlite3_close(m_db); m_db = nullptr; }
            return false;
        }

        // WAL — параллельное чтение storage-service; busy_timeout — переждать
        // короткие блокировки; synchronous NORMAL — компромисс скорость/износ.
        sqlite3_exec(m_db, "PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);
        sqlite3_exec(m_db, "PRAGMA synchronous=NORMAL;", nullptr, nullptr, nullptr);
        sqlite3_busy_timeout(m_db, 3000);

        if (!ensure_schema()) {
            sqlite3_close(m_db);
            m_db = nullptr;
            return false;
        }

        m_running.store(true);
        m_thread = std::thread(&UJournalWriter::worker, this);
        m_logger.info("started, db=" + m_db_path.string());
        return true;
    }

    void UJournalWriter::stop() {
        if (m_running.exchange(false)) {
            m_cv.notify_all();
            if (m_thread.joinable()) m_thread.join();
        }
        if (m_db) {
            sqlite3_close(m_db);
            m_db = nullptr;
        }
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
            "  image_path TEXT NOT NULL,"
            "  track_id INTEGER,"
            "  event TEXT,"
            "  dets_json TEXT NOT NULL,"
            "  verdict TEXT NOT NULL DEFAULT 'unverified',"
            "  verdict_note TEXT,"
            "  verdict_at INTEGER"
            ");"
            "CREATE TABLE IF NOT EXISTS detection_objects("
            "  det_id INTEGER NOT NULL,"
            "  cid INTEGER, cf REAL"
            ");"
            "CREATE INDEX IF NOT EXISTS idx_det_ts ON detections(ts);"
            "CREATE INDEX IF NOT EXISTS idx_det_geo ON detections(lat, lon);"
            "CREATE INDEX IF NOT EXISTS idx_det_verdict ON detections(verdict);"
            "CREATE INDEX IF NOT EXISTS idx_obj_cid ON detection_objects(cid);"
            "CREATE INDEX IF NOT EXISTS idx_obj_det ON detection_objects(det_id);";

        char* err = nullptr;
        if (sqlite3_exec(m_db, kSchema, nullptr, nullptr, &err) != SQLITE_OK) {
            m_logger.error("schema: " + std::string(err ? err : "unknown"));
            sqlite3_free(err);
            return false;
        }
        return true;
    }

    void UJournalWriter::enqueue(FEntry entry) {
        {
            std::lock_guard<std::mutex> lk(m_mutex);
            if (m_queue.size() >= kMaxQueue) m_queue.pop_front();
            m_queue.push_back(std::move(entry));
        }
        m_cv.notify_one();
    }

    FSlotJournal UJournalWriter::slot_journal() {
        return FSlotJournal{
            m_frames_dir,
            [this](FEntry e) { enqueue(std::move(e)); },
        };
    }

    void UJournalWriter::worker() {
        while (true) {
            std::deque<FEntry> batch;
            {
                std::unique_lock<std::mutex> lk(m_mutex);
                m_cv.wait(lk, [this] { return !m_queue.empty() || !m_running.load(); });
                if (!m_running.load() && m_queue.empty()) break;
                batch.swap(m_queue);
            }
            for (const auto& e : batch) {
                if (!write_entry(e)) {
                    m_logger.warn("write_entry failed, entry dropped");
                }
            }
        }
    }

    bool UJournalWriter::write_entry(const FEntry& e) {
        if (!m_db) return false;

        sqlite3_exec(m_db, "BEGIN IMMEDIATE;", nullptr, nullptr, nullptr);

        static const char* kInsertDet =
            "INSERT INTO detections("
            "ts,camera_id,config_id,lat,lon,alt,speed,course,gps_valid,"
            "width,height,image_path,track_id,event,dets_json) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);";

        sqlite3_stmt* st = nullptr;
        if (sqlite3_prepare_v2(m_db, kInsertDet, -1, &st, nullptr) != SQLITE_OK) {
            m_logger.error("prepare detections: " + std::string(sqlite3_errmsg(m_db)));
            sqlite3_exec(m_db, "ROLLBACK;", nullptr, nullptr, nullptr);
            return false;
        }

        const std::string dets_json = objects_to_json(e.objects);

        int i = 1;
        sqlite3_bind_int64(st, i++, e.ts);
        sqlite3_bind_text(st, i++, e.camera_id.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, i++, e.config_id.c_str(), -1, SQLITE_TRANSIENT);
        if (e.gps_valid) {
            sqlite3_bind_double(st, i++, e.lat);
            sqlite3_bind_double(st, i++, e.lon);
            sqlite3_bind_double(st, i++, e.alt);
            sqlite3_bind_double(st, i++, e.speed);
            sqlite3_bind_double(st, i++, e.course);
        } else {
            sqlite3_bind_null(st, i++); // lat
            sqlite3_bind_null(st, i++); // lon
            sqlite3_bind_null(st, i++); // alt
            sqlite3_bind_null(st, i++); // speed
            sqlite3_bind_null(st, i++); // course
        }
        sqlite3_bind_int(st, i++, e.gps_valid ? 1 : 0);
        sqlite3_bind_int(st, i++, e.width);
        sqlite3_bind_int(st, i++, e.height);
        sqlite3_bind_text(st, i++, e.image_path.c_str(), -1, SQLITE_TRANSIENT);
        if (e.track_id) sqlite3_bind_int64(st, i++, *e.track_id);
        else            sqlite3_bind_null(st, i++);
        sqlite3_bind_text(st, i++, e.event.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, i++, dets_json.c_str(), -1, SQLITE_TRANSIENT);

        if (sqlite3_step(st) != SQLITE_DONE) {
            m_logger.error("insert detections: " + std::string(sqlite3_errmsg(m_db)));
            sqlite3_finalize(st);
            sqlite3_exec(m_db, "ROLLBACK;", nullptr, nullptr, nullptr);
            return false;
        }
        sqlite3_finalize(st);

        const std::int64_t det_id = sqlite3_last_insert_rowid(m_db);

        // Объекты кадра — отдельными строками для индексируемого фильтра по id класса.
        static const char* kInsertObj =
            "INSERT INTO detection_objects(det_id,cid,cf) VALUES(?,?,?);";
        sqlite3_stmt* os = nullptr;
        if (sqlite3_prepare_v2(m_db, kInsertObj, -1, &os, nullptr) == SQLITE_OK) {
            for (const auto& o : e.objects) {
                sqlite3_bind_int64(os, 1, det_id);
                sqlite3_bind_int(os, 2, o.cid);
                sqlite3_bind_double(os, 3, o.cf);
                if (sqlite3_step(os) != SQLITE_DONE) {
                    m_logger.warn("insert object: " + std::string(sqlite3_errmsg(m_db)));
                }
                sqlite3_reset(os);
            }
            sqlite3_finalize(os);
        }

        sqlite3_exec(m_db, "COMMIT;", nullptr, nullptr, nullptr);
        return true;
    }

} // namespace journal
} // namespace varan
