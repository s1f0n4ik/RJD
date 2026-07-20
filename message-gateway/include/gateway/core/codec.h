#pragma once

#include <string>
#include <memory>
#include <vector>
#include <unordered_map>
#include <algorithm>

#include "gateway/message.h"

namespace varan {
    namespace gateway {

        // Результат кодирования. wire — готовые к отправке байты, binary — как их
        // слать по WS (кадр с изображением бинарный, служебное — текст).
        struct FEncodeResult {
            bool ok = false;
            std::string error;
            std::string wire;
            bool binary = true;
        };

        // Кодек одной версии протокола. Знает раскладку байт для своей версии;
        // при смене протокола добавляется новый кодек, старый остаётся.
        class ICodec {
        public:
            virtual ~ICodec() = default;

            virtual int version() const = 0;
            virtual FEncodeResult encode_frame(const FFrameMessage& msg) const = 0;
            virtual std::string encode_heartbeat(std::int64_t ts) const = 0;
        };

        // Реестр кодеков по версиям. Определяет, поддерживается ли запрошенная
        // клиентом версия сообщения.
        class UCodecRegistry {
        public:
            void register_codec(std::shared_ptr<ICodec> codec) {
                m_codecs[codec->version()] = std::move(codec);
            }

            std::shared_ptr<ICodec> find(int version) const {
                auto it = m_codecs.find(version);
                return it == m_codecs.end() ? nullptr : it->second;
            }

            bool supports(int version) const {
                return m_codecs.count(version) != 0;
            }

            std::vector<int> versions() const {
                std::vector<int> out;
                out.reserve(m_codecs.size());
                for (const auto& [ver, _] : m_codecs) {
                    out.push_back(ver);
                }
                std::sort(out.begin(), out.end());
                return out;
            }

        private:
            std::unordered_map<int, std::shared_ptr<ICodec>> m_codecs;
        };

    } // namespace gateway
} // namespace varan
