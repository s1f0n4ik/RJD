#pragma once

#include <string>
#include <vector>
#include <cstdint>

#include "gateway/message.h"

namespace varan {
    namespace gateway {

        enum class ESubmitStatus {
            Accepted,
            UnsupportedVersion,
            EncodeError,
            NotConnected
        };

        // Результат приёма кадра шлюзом. Транспортно-независим: gRPC-слой мапит его
        // в свой ответ, но business-логика про gRPC ничего не знает.
        struct FSubmitResult {
            ESubmitStatus status = ESubmitStatus::EncodeError;
            std::string error;
            int ver = 0;
            std::string transport;
            std::int64_t wire_size = 0;
            std::vector<int> supported;   // список версий при UnsupportedVersion
        };

        // Приёмник кадров. Реализуется ядром (UGateway), используется ingress-слоем
        // (gRPC), чтобы не тащить gRPC внутрь оркестратора и наоборот.
        class IFrameSink {
        public:
            virtual ~IFrameSink() = default;

            virtual FSubmitResult submit_frame(const FFrameMessage& msg) = 0;
        };

    } // namespace gateway
} // namespace varan
