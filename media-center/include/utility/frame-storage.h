#pragma once

#include <string>
#include <mutex>
#include <memory>
#include <optional>
#include <functional>
#include <unordered_map>
#include <string>

#include "drm-frame.h"

class FDmabufFrameStorage
{
public:
    FDmabufFrameStorage() = default;

    bool register_storage(const std::string& name) {
        std::lock_guard<std::mutex> lock(m_registry_mutex);

        if (m_slots.find(name) == m_slots.end()) {
            m_slots.emplace(name, std::make_unique<CameraSlot>());
            return true;
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
        CameraSlot* slot = nullptr;

        {
            std::lock_guard<std::mutex> lock(m_registry_mutex);

            auto it = m_slots.find(name);
            if (it == m_slots.end()) {
                return false;
            }

            slot = it->second.get();
        }

        // Блокируется только конкретная камера
        std::lock_guard<std::mutex> lock(slot->mutex);
        slot->frame = std::move(frame);
        return true;
    }

    // Извлечь последний кадр (через move)
    bool ExtractFrame(const std::string& name, FDmabufFrame& out) {
        CameraSlot* slot = nullptr;

        {
            std::lock_guard<std::mutex> lock(m_registry_mutex);

            auto it = m_slots.find(name);
            if (it == m_slots.end()) {
                return false;
            }

            slot = it->second.get();
        }

        std::lock_guard<std::mutex> lock(slot->mutex);

        if (!slot->frame.has_value()) {
            return false;
        }

        out = std::move(*slot->frame);
        slot->frame.reset();
        return true;
    }

private:

    struct CameraSlot
    {
        std::mutex mutex;
        std::optional<FDmabufFrame> frame; // всегда хранит только последний кадр
    };

    std::unordered_map<std::string, std::unique_ptr<CameraSlot>> m_slots;
    std::mutex m_registry_mutex;
};