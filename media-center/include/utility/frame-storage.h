#pragma once

#include <string>
#include <mutex>
#include <memory>
#include <optional>
#include <functional>
#include <unordered_map>
#include <string>

#include "dma-frame.h"
#include "logger.h"

class FDmabufFrameStorage
{
public:
    struct FCameraSlot
    {
        std::mutex mutex;
        std::optional<FDmabufFrame> frame; // всегда хранит только последний кадр

        FCameraSlot(): frame(std::nullopt) {}
        FCameraSlot& operator=(FCameraSlot& other) = delete;

        FCameraSlot& operator=(FCameraSlot&& other) noexcept {
            if (this == &other) return *this;

            std::scoped_lock lock(mutex, other.mutex);
            frame = std::move(other.frame);
            other.frame.reset();
            return *this;
        }
    };

public:
    FDmabufFrameStorage(ULogger* logger = nullptr)
        : m_logger(logger)
    {
    }

    void set_logger(ULogger* logger) { m_logger = logger; }

    bool register_storage(const std::string& name) {
        std::lock_guard<std::mutex> lock(m_registry_mutex);

        if (m_slots.find(name) == m_slots.end()) {
            m_slots[name] = std::move(FCameraSlot());
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

    // Получить callback для внешнего pipeline
    CDmabufMover get_callback() {
        return [this](std::string name, FDmabufFrame&& frame) {
            add_frame(std::move(name), std::move(frame));
        };
    }

    // Добавление кадра
    bool add_frame(std::string name, FDmabufFrame&& frame) {
        FCameraSlot* slot = nullptr;

        {
            std::lock_guard<std::mutex> lock(m_registry_mutex);

            auto it = m_slots.find(name);
            if (it == m_slots.end()) {
                if (m_logger) m_logger->warn("add_frame(): Frame received for unknown camera: " + name);

                auto& added_slot = m_slots[name];
                slot = &added_slot;

                if (m_logger) m_logger->info("add_frame(): Created camera slot for camera: " + name);
            }
            else {
                slot = &it->second;
            }
        }

        if (m_logger) {
            m_logger->trace("add_frame(): Frame stored for camera: " + name);
            m_logger->trace(frame.to_string());
        }

        // Блокируется только конкретная камера
        {
            std::lock_guard<std::mutex> lock(slot->mutex);
            slot->frame = std::move(frame);
        }
        return true;
    }

    bool is_exists(const std::string& name) {
        std::lock_guard<std::mutex> lock(m_registry_mutex);
        return !(m_slots.find(name) == m_slots.end());
    }

    // Извлечь последний кадр (через move)
    std::optional<FDmabufFrame> extract(const std::string& name) {
        FCameraSlot* slot = nullptr;

        {
            std::lock_guard<std::mutex> lock(m_registry_mutex);

            auto it = m_slots.find(name);
            if (it == m_slots.end()) {
                if (m_logger) {
                    m_logger->warn("extract(): Extract requested for unknown camera: " + name);
                }
                return std::nullopt;
            }

            slot = &it->second;
        }

        std::lock_guard<std::mutex> lock(slot->mutex);

        if (!slot->frame) {
            if (m_logger) {
                m_logger->trace("extract(): No frame available for camera: " + name);
            }
            return std::nullopt;
        }

        std::optional<FDmabufFrame> result = std::move(slot->frame);
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