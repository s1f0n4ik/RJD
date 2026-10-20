#include "archive/segment-writer.h"

#include <chrono>
#include <iomanip>
#include <random>
#include <sstream>

#include "core/time-sync.h"

namespace varan {
namespace archive {

namespace {

    // Идентификатор запуска процесса. Нужен только чтобы отличать сессии друг
    // от друга — монотонные шкалы разных запусков несравнимы между собой.
    std::string make_session_uid() {
        std::random_device rd;
        std::uniform_int_distribution<std::uint32_t> dist;

        std::ostringstream oss;
        oss << std::hex << std::setfill('0');
        for (int i = 0; i < 4; ++i) {
            oss << std::setw(8) << dist(rd);
        }
        return oss.str();
    }

    std::int64_t system_wall_ms() {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

} // namespace

    FTimeStamp now_stamp() {
        FTimeStamp stamp;
        stamp.mono_ms = time_sync::mono_ms();

        if (time_sync::trusted()) {
            stamp.wall_ms = time_sync::now_ms();
            stamp.source = ETimeSource::SADKO;
        }
        else if (time_sync::synced()) {
            // Шлюз на связи, но время у него своё — берём его же, чтобы метки
            // всех устройств изделия хотя бы совпадали между собой
            stamp.wall_ms = time_sync::now_ms();
            stamp.source = ETimeSource::SYSTEM;
        }
        else {
            stamp.wall_ms = system_wall_ms();
            stamp.source = ETimeSource::NONE;
        }
        return stamp;
    }

    USegmentWriter::USegmentWriter(std::filesystem::path db_path, ULogger::ELoggerLevel level)
        : db::AAsyncWriter<FSegmentEvent>(std::move(db_path), "SegmentWriter", level)
        , m_session_uid(make_session_uid())
    {
    }

    USegmentWriter::~USegmentWriter() {
        stop();
    }

    bool USegmentWriter::ensure_schema() {
        // sessions и segments пишет media-center. Поправки времени storage-service
        // держит в своей таблице и создаёт её сам — сюда мы не лезем.
        static const char* kSchema =
            "CREATE TABLE IF NOT EXISTS sessions("
            "  id INTEGER PRIMARY KEY,"
            "  uid TEXT NOT NULL UNIQUE,"
            // Монотонное и настенное время старта процесса + чего стоит второе
            "  started_mono_ms INTEGER NOT NULL,"
            "  started_wall_ms INTEGER NOT NULL,"
            "  time_source TEXT NOT NULL,"
            // Проставляются при штатной остановке; пусто — процесс убит или
            // изделие обесточено, и конец сессии считается по последнему сегменту
            "  stopped_mono_ms INTEGER,"
            "  stopped_wall_ms INTEGER"
            ");"
            "CREATE TABLE IF NOT EXISTS segments("
            "  id INTEGER PRIMARY KEY,"
            "  session_uid TEXT NOT NULL,"
            "  camera_id TEXT NOT NULL,"
            "  stream_key TEXT NOT NULL,"
            "  path TEXT NOT NULL UNIQUE,"
            "  mono_start_ms INTEGER NOT NULL,"
            "  mono_end_ms INTEGER,"
            "  wall_start_ms INTEGER NOT NULL,"
            "  wall_end_ms INTEGER,"
            "  time_source TEXT NOT NULL,"
            "  size_bytes INTEGER,"
            // 0 — фрагмент ещё пишется либо оборван обесточиванием
            "  closed INTEGER NOT NULL DEFAULT 0,"
            // mc — строку записала ветка записи, scan — нашёл storage-service
            "  origin TEXT NOT NULL DEFAULT 'mc',"
            // Том пула дисков; NULL — внутренний том
            "  volume_id TEXT,"
            // Почему запись прервалась на конце сегмента: "<код>: <подробности>"
            "  error TEXT,"
            // 1 — storage-service сверил строку с содержимым файла
            "  verified INTEGER NOT NULL DEFAULT 0"
            ");"
            // Точка соответствия монотонного и настенного времени. Пишется, когда
            // источник стал лучше: по ней storage-service ставит якорь сессии,
            // не дожидаясь первого фрагмента
            "CREATE TABLE IF NOT EXISTS time_marks("
            "  id INTEGER PRIMARY KEY,"
            "  session_uid TEXT NOT NULL,"
            "  mono_ms INTEGER NOT NULL,"
            "  wall_ms INTEGER NOT NULL,"
            "  time_source TEXT NOT NULL"
            ");"
            "CREATE INDEX IF NOT EXISTS idx_seg_track ON segments(camera_id, stream_key, wall_start_ms);"
            "CREATE INDEX IF NOT EXISTS idx_seg_session ON segments(session_uid);"
            "CREATE INDEX IF NOT EXISTS idx_seg_open ON segments(closed);"
            "CREATE INDEX IF NOT EXISTS idx_mark_session ON time_marks(session_uid, mono_ms);";

        if (!db().exec(kSchema, "schema")) return false;

        // Базы прежних сборок без тома пула, причины прерывания и сверки
        db().add_column("segments", "volume_id", "TEXT");
        db().add_column("segments", "error", "TEXT");
        db().add_column("segments", "verified", "INTEGER NOT NULL DEFAULT 0");
        return db().exec("CREATE INDEX IF NOT EXISTS idx_seg_volume ON segments(volume_id);", "volume index");
    }

    void USegmentWriter::on_started() {
        insert_session();

        logger().info("started: db=" + db_path().string() +
            " session=" + m_session_uid +
            " segments=" + std::to_string(db().row_count("segments")));
    }

    void USegmentWriter::on_stopping() {
        const FTimeStamp stamp = now_stamp();
        logger().info("stopping: rows written this session=" + std::to_string(m_written.load()));

        db::UStatement update(db(),
            "UPDATE sessions SET stopped_mono_ms=?, stopped_wall_ms=? WHERE uid=?;");
        if (!update.ok()) {
            logger().warn("prepare session close: " + db().error());
            return;
        }

        update.bind(stamp.mono_ms).bind(stamp.wall_ms).bind(m_session_uid);
        if (!update.step_done()) {
            logger().warn("close session: " + db().error());
            return;
        }
        logger().info("session closed: " + m_session_uid);
    }

    bool USegmentWriter::insert_session() {
        const FTimeStamp stamp = now_stamp();
        m_started_mono_ms = stamp.mono_ms;

        db::UStatement insert(db(),
            "INSERT INTO sessions(uid,started_mono_ms,started_wall_ms,time_source) "
            "VALUES(?,?,?,?);");
        if (!insert.ok()) {
            logger().error("prepare session: " + db().error());
            return false;
        }

        insert.bind(m_session_uid)
              .bind(stamp.mono_ms)
              .bind(stamp.wall_ms)
              .bind(std::string(to_string(stamp.source)));

        if (!insert.step_done()) {
            logger().error("insert session: " + db().error());
            return false;
        }
        return true;
    }

    bool USegmentWriter::write_one(const FSegmentEvent& event) {
        if (!db().is_open()) return false;

        switch (event.kind) {
        case FSegmentEvent::EKind::OPENED:    return open_segment(event);
        case FSegmentEvent::EKind::CLOSED:    return close_segment(event);
        case FSegmentEvent::EKind::ERROR:     return mark_error(event);
        case FSegmentEvent::EKind::TIME_MARK: return insert_mark(event);
        }
        return false;
    }

    void USegmentWriter::note_time() {
        if (!running()) return;

        const FTimeStamp stamp = now_stamp();
        const int rank = static_cast<int>(stamp.source);

        // Пишем только улучшение: шлюз отвечает раз в десять секунд, а точек
        // на сессию должно быть не больше трёх
        int best = m_best_source.load();
        while (rank > best) {
            if (m_best_source.compare_exchange_weak(best, rank)) {
                FSegmentEvent event;
                event.kind = FSegmentEvent::EKind::TIME_MARK;
                event.mono_ms = stamp.mono_ms;
                event.wall_ms = stamp.wall_ms;
                event.source = stamp.source;
                enqueue(std::move(event));
                return;
            }
        }
    }

    bool USegmentWriter::insert_mark(const FSegmentEvent& event) {
        db::UStatement insert(db(),
            "INSERT INTO time_marks(session_uid,mono_ms,wall_ms,time_source) "
            "VALUES(?,?,?,?);");
        if (!insert.ok()) {
            logger().warn("prepare time mark: " + db().error());
            return false;
        }

        insert.bind(m_session_uid)
              .bind(event.mono_ms)
              .bind(event.wall_ms)
              .bind(std::string(to_string(event.source)));

        if (!insert.step_done()) {
            logger().warn("insert time mark: " + db().error());
            return false;
        }

        logger().info("time source improved to " + std::string(to_string(event.source))
            + ", mark written at mono=" + std::to_string(event.mono_ms));
        return true;
    }

    bool USegmentWriter::open_segment(const FSegmentEvent& event) {
        // Тот же путь мог остаться от прошлой сессии, оборванной по питанию:
        // файл перезаписывается, значит и строка должна принадлежать новой
        db::UStatement insert(db(),
            "INSERT INTO segments("
            "session_uid,camera_id,stream_key,path,mono_start_ms,wall_start_ms,time_source,origin,volume_id) "
            "VALUES(?,?,?,?,?,?,?,'mc',?) "
            "ON CONFLICT(path) DO UPDATE SET "
            "session_uid=excluded.session_uid,"
            "camera_id=excluded.camera_id,"
            "stream_key=excluded.stream_key,"
            "mono_start_ms=excluded.mono_start_ms,"
            "wall_start_ms=excluded.wall_start_ms,"
            "time_source=excluded.time_source,"
            "volume_id=excluded.volume_id,"
            "mono_end_ms=NULL,wall_end_ms=NULL,size_bytes=NULL,closed=0,origin='mc',"
            "error=NULL,verified=0;");

        if (!insert.ok()) {
            logger().error("prepare segment open: " + db().error());
            return false;
        }

        insert.bind(m_session_uid)
              .bind(event.camera_id)
              .bind(event.stream_key)
              .bind(event.path)
              .bind(event.mono_ms)
              .bind(event.wall_ms)
              .bind(std::string(to_string(event.source)))
              .bind_text_or_null(event.volume_id);

        if (!insert.step_done()) {
            logger().error("insert segment: " + db().error());
            return false;
        }

        ++m_written;
        return true;
    }

    bool USegmentWriter::close_segment(const FSegmentEvent& event) {
        // Неизвестный конец или размер не затирает то, что уже измерил storage-service
        db::UStatement update(db(),
            "UPDATE segments SET mono_end_ms=COALESCE(?, mono_end_ms), "
            "wall_end_ms=COALESCE(?, wall_end_ms), size_bytes=COALESCE(?, size_bytes), "
            "closed=1, verified=0 WHERE path=?;");

        if (!update.ok()) {
            logger().error("prepare segment close: " + db().error());
            return false;
        }

        if (event.has_end) update.bind(event.mono_ms).bind(event.wall_ms);
        else update.bind_null().bind_null();
        if (event.size_bytes >= 0) update.bind(event.size_bytes);
        else update.bind_null();
        update.bind(event.path);

        if (!update.step_done()) {
            logger().error("close segment: " + db().error());
            return false;
        }

        ++m_written;
        return true;
    }

    bool USegmentWriter::mark_error(const FSegmentEvent& event) {
        // Остаётся первая причина: следующие ошибки — уже следствие
        db::UStatement update(db(),
            "UPDATE segments SET error=COALESCE(error, ?) WHERE path=?;");

        if (!update.ok()) {
            logger().error("prepare segment error: " + db().error());
            return false;
        }

        update.bind(event.error).bind(event.path);

        if (!update.step_done()) {
            logger().error("segment error: " + db().error());
            return false;
        }

        ++m_written;
        return true;
    }

} // namespace archive
} // namespace varan
