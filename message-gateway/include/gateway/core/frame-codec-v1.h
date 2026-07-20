#pragma once

#include "gateway/codec.h"

namespace varan {
    namespace gateway {

        // Кодек версии 1 протокола обмена изображениями СВН -> КАУС.
        // Бинарный кадр: [uint32 BE длина JSON][JSON-заголовок UTF-8][байты image].
        // Служебные сообщения (heartbeat) — текстовый JSON.
        class UFrameCodecV1 : public ICodec {
        public:
            int version() const override { return 1; }

            FEncodeResult encode_frame(const FFrameMessage& msg) const override;
            std::string encode_heartbeat(std::int64_t ts) const override;
        };

    } // namespace gateway
} // namespace varan
