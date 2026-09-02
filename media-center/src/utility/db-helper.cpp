#include "utility/db-helper.h"

#include <sqlite3.h>

#include <fstream>
#include <system_error>

namespace varan {
namespace db {

    bool UConnection::open(const std::filesystem::path& db_path) {
        close();
        m_path = db_path;

        const std::filesystem::path dir = db_path.parent_path();
        std::error_code ec;
        std::filesystem::create_directories(dir, ec);
        if (ec) {
            m_logger.error("cannot create " + dir.string() + ": " + ec.message());
        }

        if (!std::filesystem::exists(dir)) {
            m_logger.error("database directory does not exist and cannot be created: " + dir.string()
                + " — create it and give it to the user media-center runs as:"
                " sudo mkdir -p " + dir.string() + " && sudo chown -R $USER " + dir.string());
            return false;
        }

        // Явная проба записи: понятная причина вместо общей ошибки sqlite.
        {
            const std::filesystem::path probe = dir / ".db-write-test";
            std::ofstream file(probe, std::ios::binary);
            if (!file) {
                m_logger.error("database directory is not writable: " + dir.string()
                    + " — media-center runs as a user that doesn't own the directory."
                    " Fix: sudo chown -R $USER " + dir.string());
                return false;
            }
            file.close();
            std::error_code rm_ec;
            std::filesystem::remove(probe, rm_ec);
        }

        if (sqlite3_open_v2(db_path.string().c_str(), &m_db,
                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr) != SQLITE_OK) {
            m_logger.error("open(" + db_path.string() + "): " +
                (m_db ? sqlite3_errmsg(m_db) : "no handle"));
            if (m_db) { sqlite3_close(m_db); m_db = nullptr; }
            return false;
        }

        // WAL — параллельное чтение storage-service; busy_timeout — переждать
        // короткие блокировки; synchronous NORMAL — компромисс скорость/износ.
        sqlite3_exec(m_db, "PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);
        sqlite3_exec(m_db, "PRAGMA synchronous=NORMAL;", nullptr, nullptr, nullptr);
        sqlite3_busy_timeout(m_db, 3000);
        return true;
    }

    void UConnection::close() {
        if (m_db) {
            sqlite3_close(m_db);
            m_db = nullptr;
        }
    }

    bool UConnection::exec(const char* sql, const char* what) {
        if (!m_db) return false;

        char* err = nullptr;
        if (sqlite3_exec(m_db, sql, nullptr, nullptr, &err) != SQLITE_OK) {
            m_logger.error(std::string(what) + ": " + std::string(err ? err : "unknown"));
            sqlite3_free(err);
            return false;
        }
        return true;
    }

    bool UConnection::column_exists(const char* table, const char* column) const {
        if (!m_db) return false;

        const std::string sql = std::string("PRAGMA table_info(") + table + ");";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(m_db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) return false;

        bool found = false;
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            const unsigned char* name = sqlite3_column_text(stmt, 1);
            if (name && std::string(reinterpret_cast<const char*>(name)) == column) {
                found = true;
                break;
            }
        }
        sqlite3_finalize(stmt);
        return found;
    }

    void UConnection::add_column(const char* table, const char* column, const char* decl) {
        if (!m_db || column_exists(table, column)) return;

        const std::string sql = std::string("ALTER TABLE ") + table +
            " ADD COLUMN " + column + " " + decl + ";";

        char* err = nullptr;
        if (sqlite3_exec(m_db, sql.c_str(), nullptr, nullptr, &err) != SQLITE_OK) {
            m_logger.warn(std::string("migrate ") + table + "." + column + ": " +
                std::string(err ? err : "unknown"));
        }
        else {
            m_logger.info(std::string("migrated: ") + table + "." + column + " added");
        }
        sqlite3_free(err);
    }

    std::int64_t UConnection::row_count(const char* table) const {
        if (!m_db) return -1;

        const std::string sql = std::string("SELECT COUNT(*) FROM ") + table + ";";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(m_db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) return -1;

        std::int64_t rows = -1;
        if (sqlite3_step(stmt) == SQLITE_ROW) rows = sqlite3_column_int64(stmt, 0);
        sqlite3_finalize(stmt);
        return rows;
    }

    std::int64_t UConnection::last_insert_rowid() const {
        return m_db ? sqlite3_last_insert_rowid(m_db) : 0;
    }

    std::string UConnection::error() const {
        return m_db ? sqlite3_errmsg(m_db) : "no handle";
    }

    // ── Транзакция ──

    UTransaction::UTransaction(UConnection& conn) : m_conn(conn) {
        m_active = m_conn.exec("BEGIN IMMEDIATE;", "begin");
    }

    UTransaction::~UTransaction() {
        if (m_active) m_conn.exec("ROLLBACK;", "rollback");
    }

    bool UTransaction::commit() {
        if (!m_active) return false;
        m_active = false;
        return m_conn.exec("COMMIT;", "commit");
    }

    // ── Запрос ──

    UStatement::UStatement(UConnection& conn, const char* sql) : m_conn(conn) {
        if (!conn.is_open()) return;
        if (sqlite3_prepare_v2(conn.handle(), sql, -1, &m_stmt, nullptr) != SQLITE_OK) {
            m_stmt = nullptr;
        }
    }

    UStatement::~UStatement() {
        if (m_stmt) sqlite3_finalize(m_stmt);
    }

    UStatement& UStatement::bind(std::int64_t value) {
        if (m_stmt) sqlite3_bind_int64(m_stmt, m_index++, value);
        return *this;
    }

    UStatement& UStatement::bind(int value) {
        if (m_stmt) sqlite3_bind_int(m_stmt, m_index++, value);
        return *this;
    }

    UStatement& UStatement::bind(double value) {
        if (m_stmt) sqlite3_bind_double(m_stmt, m_index++, value);
        return *this;
    }

    UStatement& UStatement::bind(bool value) {
        if (m_stmt) sqlite3_bind_int(m_stmt, m_index++, value ? 1 : 0);
        return *this;
    }

    UStatement& UStatement::bind(const std::string& value) {
        if (m_stmt) sqlite3_bind_text(m_stmt, m_index++, value.c_str(), -1, SQLITE_TRANSIENT);
        return *this;
    }

    UStatement& UStatement::bind_text_or_null(const std::string& value) {
        return value.empty() ? bind_null() : bind(value);
    }

    UStatement& UStatement::bind_null() {
        if (m_stmt) sqlite3_bind_null(m_stmt, m_index++);
        return *this;
    }

    bool UStatement::step_done() {
        return m_stmt && sqlite3_step(m_stmt) == SQLITE_DONE;
    }

    bool UStatement::step_row() {
        return m_stmt && sqlite3_step(m_stmt) == SQLITE_ROW;
    }

    void UStatement::reset() {
        if (!m_stmt) return;
        sqlite3_reset(m_stmt);
        m_index = 1;
    }

    std::int64_t UStatement::column_int64(int index) const {
        return m_stmt ? sqlite3_column_int64(m_stmt, index) : 0;
    }

    std::string UStatement::column_text(int index) const {
        if (!m_stmt) return {};
        const unsigned char* text = sqlite3_column_text(m_stmt, index);
        return text ? reinterpret_cast<const char*>(text) : "";
    }

} // namespace db
} // namespace varan
