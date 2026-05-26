#pragma once

#include <string>
#include <mutex>
#include <memory>
#include <optional>
#include <functional>
#include <unordered_map>
#include <string>

#include "logger.h"

template<typename TFrame>
class FFrameStorage
{
public:
    using TFramePtr = std::unique_ptr<TFrame>;
    using TStorageCallback = std::function<void(std::string, TFramePtr)>;

    struct FCameraSlot {
        std::mutex mutex;
        TFramePtr frame = nullptr; // nullptr = нет кадра

        FCameraSlot() = default;

        FCameraSlot(const FCameraSlot&) = delete;
        FCameraSlot& operator=(const FCameraSlot&) = delete;

        FCameraSlot(FCameraSlot&& other) noexcept {
            std::scoped_lock lock(other.mutex);
            frame = std::move(other.frame);
        }

        FCameraSlot& operator=(FCameraSlot&& other) noexcept {
            if (this == &other) return *this;

            std::scoped_lock lock(mutex, other.mutex);
            frame = std::move(other.frame);
            return *this;
        }
    };

public:
    FFrameStorage(ULogger* logger = nullptr)
        : m_logger(logger)
    {
    }

    void set_logger(ULogger* logger) { m_logger = logger; }

    bool register_storage(const std::string& name) {
        std::lock_guard<std::mutex> lock(m_registry_mutex);

        if (m_slots.find(name) == m_slots.end()) {
            m_slots.emplace(name, FCameraSlot{});

            if (m_logger) {
                m_logger->info("register_storage(): Registered storage for camera: " + name);
            }
            return true;
        }

        if (m_logger) {
            m_logger->warn("register_storage(): Camera already registered: " + name);
        }
        return false;
    }

    // Получить callback для внешнего пользователя
    TStorageCallback get_callback() {
        return [this](std::string name, TFramePtr frame) {
            add_frame(std::move(name), std::move(frame));
        };
    }

    // Добавление кадра
    bool add_frame(std::string name, TFramePtr frame) {
        if (!frame) {
            if (m_logger) {
                m_logger->warn("add_frame(): nullptr frame for camera: " + name);
            }
            return false;
        }

        FCameraSlot* slot = nullptr;
        {
            std::lock_guard<std::mutex> lock(m_registry_mutex);

            auto it = m_slots.find(name);
            if (it == m_slots.end()) {
                auto& added = m_slots[name];
                slot = &added;

                if (m_logger) {
                    m_logger->info("add_frame(): Created camera slot for camera: " + name);
                }
            }
            else {
                slot = &it->second;
            }
        }
        std::string frame_string;
        {
            std::lock_guard<std::mutex> lock(slot->mutex);
            frame_string = frame->to_string();
            slot->frame = std::move(frame); // старый кадр уничтожится автоматически
        }

        if (m_logger) {
            m_logger->trace("add_frame(): Frame stored for camera: " + name);
            m_logger->trace("add_frame(): Stored frame: " + frame_string);
        }

        return true;
    }


    bool is_exists(const std::string& name) {
        std::lock_guard<std::mutex> lock(m_registry_mutex);
        return !(m_slots.find(name) == m_slots.end());
    }

    // Извлечь последний кадр (через move)
    TFramePtr extract(const std::string& name) {
        FCameraSlot* slot = nullptr;
        {
            std::lock_guard<std::mutex> lock(m_registry_mutex);

            auto it = m_slots.find(name);
            if (it == m_slots.end()) {
                return nullptr;
            }

            slot = &it->second;
        }

        std::lock_guard<std::mutex> lock(slot->mutex);

        if (!slot->frame) {
            if (m_logger) {
                m_logger->trace("extract(): No frame for camera: " + name);
            }
            return nullptr;
        }

        TFramePtr result = std::move(slot->frame);
        slot->frame.reset();

        if (m_logger) {
            m_logger->trace("extract(): Frame extracted for camera: " + name);
        }

        return result;
    }

private:
    std::unordered_map<std::string, FCameraSlot> m_slots;
    std::mutex m_registry_mutex;

    ULogger* m_logger = nullptr;
};