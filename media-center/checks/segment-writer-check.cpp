// Самопроверка SQL индекса сегментов: g++ -std=c++20 -Iinclude checks/segment-writer-check.cpp src/archive/segment-writer.cpp src/utility/db-helper.cpp -lsqlite3 -pthread -o /tmp/segment-writer-check && /tmp/segment-writer-check

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>

#include <sqlite3.h>

#include "archive/segment-writer.h"

using namespace varan::archive;

#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); std::exit(1); } } while (0)

static const char* kDb = "/tmp/segment-writer-check.db";

// Сырое соединение: база видна так же, как её видит storage-service
static void exec(const std::string& sql) {
    sqlite3* db = nullptr;
    CHECK(sqlite3_open(kDb, &db) == SQLITE_OK);
    CHECK(sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK);
    sqlite3_close(db);
}

// Первое поле первой строки текстом; "NULL" — пусто
static std::string scalar(const std::string& sql) {
    sqlite3* db = nullptr;
    sqlite3_stmt* stmt = nullptr;
    CHECK(sqlite3_open(kDb, &db) == SQLITE_OK);
    CHECK(sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) == SQLITE_OK);
    std::string value = "NULL";
    if (sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_type(stmt, 0) != SQLITE_NULL) {
        value = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    }
    sqlite3_finalize(stmt);
    sqlite3_close(db);
    return value;
}

static std::string field(const char* column, const char* path) {
    return scalar(std::string("SELECT ") + column + " FROM segments WHERE path='" + path + "';");
}

static FSegmentEvent opened(const char* path, std::int64_t mono_ms) {
    FSegmentEvent event;
    event.kind = FSegmentEvent::EKind::OPENED;
    event.camera_id = "camera_1";
    event.stream_key = "stream_1";
    event.path = path;
    event.mono_ms = mono_ms;
    event.wall_ms = mono_ms + 1'000'000;
    return event;
}

static FSegmentEvent closed(const char* path, bool has_end, std::int64_t end_ms, std::int64_t size_bytes) {
    FSegmentEvent event;
    event.kind = FSegmentEvent::EKind::CLOSED;
    event.path = path;
    event.has_end = has_end;
    event.mono_ms = end_ms;
    event.wall_ms = end_ms + 1'000'000;
    event.size_bytes = size_bytes;
    return event;
}

static FSegmentEvent failure(const char* path, const char* text) {
    FSegmentEvent event;
    event.kind = FSegmentEvent::EKind::ERROR;
    event.path = path;
    event.error = text;
    return event;
}

// Сессия писателя: события ложатся в базу к выходу из функции
template <typename... TEvents>
static void write(TEvents... events) {
    USegmentWriter writer(kDb);
    CHECK(writer.start());
    (writer.enqueue(events), ...);
    writer.stop();
}

int main() {
    for (const char* suffix : { "", "-wal", "-shm" }) std::filesystem::remove(std::string(kDb) + suffix);

    // База прежней сборки: без тома, причины и сверки
    exec("CREATE TABLE segments(id INTEGER PRIMARY KEY, session_uid TEXT NOT NULL, camera_id TEXT NOT NULL,"
         " stream_key TEXT NOT NULL, path TEXT NOT NULL UNIQUE, mono_start_ms INTEGER NOT NULL, mono_end_ms INTEGER,"
         " wall_start_ms INTEGER NOT NULL, wall_end_ms INTEGER, time_source TEXT NOT NULL, size_bytes INTEGER,"
         " closed INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT 'mc');");

    // Обычный фрагмент: конец и размер от mc
    write(opened("/a.mp4", 1000), closed("/a.mp4", true, 601000, 123));
    CHECK(field("mono_start_ms", "/a.mp4") == "1000");
    CHECK(field("mono_end_ms", "/a.mp4") == "601000");
    CHECK(field("size_bytes", "/a.mp4") == "123");
    CHECK(field("closed", "/a.mp4") == "1");
    CHECK(field("verified", "/a.mp4") == "0");
    CHECK(field("error", "/a.mp4") == "NULL");

    // storage-service закрыл зависший фрагмент сам, запоздавшее закрытие mc без конца его не затирает
    write(opened("/b.mp4", 2000));
    exec("UPDATE segments SET mono_end_ms=32000, wall_end_ms=1032000, size_bytes=77, closed=1, verified=1,"
         " error='stalled: no growth for 30 s' WHERE path='/b.mp4';");
    write(closed("/b.mp4", false, 0, -1));
    CHECK(field("mono_end_ms", "/b.mp4") == "32000");
    CHECK(field("wall_end_ms", "/b.mp4") == "1032000");
    CHECK(field("size_bytes", "/b.mp4") == "77");
    CHECK(field("error", "/b.mp4") == "stalled: no growth for 30 s");
    CHECK(field("verified", "/b.mp4") == "0");

    // Остаётся первая причина
    write(opened("/c.mp4", 3000), failure("/c.mp4", "record_error: sink: Could not write"),
          failure("/c.mp4", "volume_lost: /storage/media/X"));
    CHECK(field("error", "/c.mp4") == "record_error: sink: Could not write");
    CHECK(field("closed", "/c.mp4") == "0");

    // Повторное открытие того же пути начинает строку заново
    write(closed("/c.mp4", true, 9000, 5));
    exec("UPDATE segments SET verified=1 WHERE path='/c.mp4';");
    write(opened("/c.mp4", 50000));
    CHECK(field("mono_start_ms", "/c.mp4") == "50000");
    CHECK(field("mono_end_ms", "/c.mp4") == "NULL");
    CHECK(field("closed", "/c.mp4") == "0");
    CHECK(field("error", "/c.mp4") == "NULL");
    CHECK(field("verified", "/c.mp4") == "0");

    std::printf("segment-writer-check: OK\n");
    return 0;
}
