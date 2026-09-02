#pragma once

#include <filesystem>

#include "journal/types.h"
#include "utility/db-helper.h"

namespace varan {
namespace journal {

    // Асинхронная запись журнала обнаружений в бд, только записи, без изображений
    class UJournalWriter : public db::AAsyncWriter<FEntry> {
    public:
        // frames_dir — корень для записанных изображений для согласования записей и фоток
        UJournalWriter(std::filesystem::path db_path,
                       std::filesystem::path frames_dir,
                       ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG);
        ~UJournalWriter() override;

        // Ручка журналирования для слота (корень кадров + sink)
        FSlotJournal slot_journal();

        const std::filesystem::path& frames_dir() const { return m_frames_dir; }

    protected:
        bool prepare() override;
        bool ensure_schema() override;
        bool write_one(const FEntry& entry) override;
        void on_started() override;

    private:
        std::filesystem::path m_frames_dir;
    };

} // namespace journal
} // namespace varan
