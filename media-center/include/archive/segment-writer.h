#pragma once

#include <atomic>
#include <filesystem>
#include <string>

#include "archive/types.h"
#include "utility/db-helper.h"

namespace varan {
namespace archive {

    // Класс для записи данных о сегменте в базу данных
    class USegmentWriter : public db::AAsyncWriter<FSegmentEvent> {
    public:
        USegmentWriter(std::filesystem::path db_path,
                       ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG);
        ~USegmentWriter() override;

        const std::string& session_uid() const { return m_session_uid; }

        // Сколько строк легло в базу за эту сессию — состояние записи наружу
        std::int64_t written() const { return m_written.load(); }

        // Зовется на каждый ответ шлюза для маркировки улучшения источника
        void note_time();

    protected:
        bool ensure_schema() override;
        bool write_one(const FSegmentEvent& event) override;
        void on_started() override;
        void on_stopping() override;

    private:
        bool open_segment(const FSegmentEvent& event);
        bool close_segment(const FSegmentEvent& event);
        bool insert_mark(const FSegmentEvent& event);
        // Старт сессии в БД - по включению записи, 
        // позволит избегать наложения времени, если оно отсутсвует на устройстве
        bool insert_session();

        std::string m_session_uid;
        std::int64_t m_started_mono_ms = 0;
        std::atomic<std::int64_t> m_written{ 0 };
        // Лучший источник времени за сессию: NONE < SYSTEM < SADKO
        std::atomic<int> m_best_source{ -1 };
    };

    // Снимок времени для события: настенные мс и то, чего они стоят.
    // Живёт здесь, чтобы ветка записи не разбиралась с источниками времени.
    struct FTimeStamp {
        std::int64_t wall_ms = 0;
        std::int64_t mono_ms = 0;
        ETimeSource source = ETimeSource::NONE;
    };

    FTimeStamp now_stamp();

} // namespace archive
} // namespace varan
