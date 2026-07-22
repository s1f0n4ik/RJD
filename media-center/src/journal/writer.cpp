#include "journal/writer.h"

#include <sqlite3.h>

#include <boost/json.hpp>

#include <fstream>

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

    // Есть ли колонка в таблице — для мягкой миграции уже созданной БД.
    bool column_exists(sqlite3* db, const char* table, const char* column) {
        const std::string sql = std::string("PRAGMA table_info(") + table + ");";
        sqlite3_stmt* st = nullptr;
        if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return false;
        bool found = false;
        while (sqlite3_step(st) == SQLITE_ROW) {
            const unsigned char* name = sqlite3_column_text(st, 1);
            if (name && std::string(reinterpret_cast<const char*>(name)) == column) {
                found = true;
                break;
            }
        }
        sqlite3_finalize(st);
        return found;
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

        // Каталоги под базу и кадры создаём заранее
        const std::filesystem::path db_dir = m_db_path.parent_path();
        std::error_code ec;
        std::filesystem::create_directories(db_dir, ec);
        if (ec) {
            m_logger.error("cannot create " + db_dir.string() + ": " + ec.message());
        }
        std::error_code ec_frames;
        std::filesystem::create_directories(m_frames_dir, ec_frames);
        if (ec_frames) {
            m_logger.error("cannot create " + m_frames_dir.string() + ": " + ec_frames.message());
        }

        if (!std::filesystem::exists(db_dir)) {
            m_logger.error("journal directory does not exist and cannot be created: " + db_dir.string()
                + " — создайте его и отдайте пользователю, под которым работает media-center:"
                " sudo mkdir -p " + db_dir.string() + " && sudo chown -R $USER " + db_dir.string());
            return false;
        }

        // Явная проба записи: даёт понятную причину вместо общей ошибки sqlite.
        {
            const std::filesystem::path probe = db_dir / ".journal-write-test";
            std::ofstream f(probe, std::ios::binary);
            if (!f) {
                m_logger.error("journal directory is not writable: " + db_dir.string()
                    + " — media-center работает не под тем пользователем, которому принадлежит каталог."
                    " Исправить: sudo chown -R $USER " + db_dir.string());
                return false;
            }
            f.close();
            std::error_code rm_ec;
            std::filesystem::remove(probe, rm_ec);
        }

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

        // Состояние журнала на момент запуска — чтобы в логе сразу было видно,
        // что БД открыта, и сколько записей в ней уже есть.
        std::int64_t rows = -1;
        sqlite3_stmt* cst = nullptr;
        if (sqlite3_prepare_v2(m_db, "SELECT COUNT(*) FROM detections;", -1, &cst, nullptr) == SQLITE_OK) {
            if (sqlite3_step(cst) == SQLITE_ROW) rows = sqlite3_column_int64(cst, 0);
            sqlite3_finalize(cst);
        }

        m_running.store(true);
        m_thread = std::thread(&UJournalWriter::worker, this);
        m_logger.info("started: db=" + m_db_path.string() +
            " frames=" + m_frames_dir.string() +
            " rows=" + std::to_string(rows));
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

        char* err = nullptr;
        if (sqlite3_exec(m_db, kSchema, nullptr, nullptr, &err) != SQLITE_OK) {
            m_logger.error("schema: " + std::string(err ? err : "unknown"));
            sqlite3_free(err);
            return false;
        }

        // Мягкая миграция БД, созданной прежней версией: колонка state добавлена позже.
        if (!column_exists(m_db, "detection_objects", "state")) {
            char* aerr = nullptr;
            if (sqlite3_exec(m_db, "ALTER TABLE detection_objects ADD COLUMN state TEXT;",
                    nullptr, nullptr, &aerr) != SQLITE_OK) {
                m_logger.warn("migrate detection_objects.state: " + std::string(aerr ? aerr : "unknown"));
            }
            else {
                m_logger.info("migrated: detection_objects.state added");
            }
            sqlite3_free(aerr);
        }
        return true;
    }

    void UJournalWriter::enqueue(FEntry entry) {
        bool dropped = false;
        {
            std::lock_guard<std::mutex> lk(m_mutex);
            if (m_queue.size() >= kMaxQueue) {
                m_queue.pop_front();
                dropped = true;
            }
            m_queue.push_back(std::move(entry));
        }
        if (dropped) m_logger.warn("sql queue overflow, oldest row dropped");
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
        // Пустой путь — кадр потерян, пишем NULL вместо пустой строки.
        if (e.image_path.empty()) sqlite3_bind_null(st, i++);
        else sqlite3_bind_text(st, i++, e.image_path.c_str(), -1, SQLITE_TRANSIENT);
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
            "INSERT INTO detection_objects(det_id,cid,cf,state) VALUES(?,?,?,?);";
        sqlite3_stmt* os = nullptr;
        if (sqlite3_prepare_v2(m_db, kInsertObj, -1, &os, nullptr) == SQLITE_OK) {
            for (const auto& o : e.objects) {
                sqlite3_bind_int64(os, 1, det_id);
                sqlite3_bind_int(os, 2, o.cid);
                sqlite3_bind_double(os, 3, o.cf);
                sqlite3_bind_text(os, 4, o.state.c_str(), -1, SQLITE_TRANSIENT);
                if (sqlite3_step(os) != SQLITE_DONE) {
                    m_logger.warn("insert object: " + std::string(sqlite3_errmsg(m_db)));
                }
                sqlite3_reset(os);
            }
            sqlite3_finalize(os);
        }

        sqlite3_exec(m_db, "COMMIT;", nullptr, nullptr, nullptr);

        m_logger.info("row written: id=" + std::to_string(det_id) +
            " camera=" + e.camera_id +
            " objects=" + std::to_string(e.objects.size()) +
            (e.image_path.empty() ? " image=<dropped>" : " image=" + e.image_path));
        return true;
    }

} // namespace journal
} // namespace varan
