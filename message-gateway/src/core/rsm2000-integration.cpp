#include "gateway/core/rsm2000-integration.h"
#include "gateway/utility/log.h"

#include <algorithm>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {
            const char* TAG = "integration:rsm-2000";
        }

        URsm2000Integration::URsm2000Integration(boost::asio::io_context& ioc, FWsConfig ws,
            FCanConfig can, int heartbeat_sec, const UTaxonomy& taxonomy, UTimeSource& time_source)
        {
            m_modules.push_back(std::make_shared<UWsModule>(ioc, std::move(ws), heartbeat_sec));
            m_modules.push_back(std::make_shared<UCanModule>(ioc, std::move(can), taxonomy, time_source));
        }

        std::shared_ptr<IModule> URsm2000Integration::find_module(const std::string& id) const {
            for (const auto& m : m_modules) {
                if (m->id() == id) {
                    return m;
                }
            }
            return nullptr;
        }

        void URsm2000Integration::start() {
            for (const auto& m : m_modules) {
                m->start();
            }
            ULog::info(TAG, "Started");
        }

        void URsm2000Integration::stop() {
            for (const auto& m : m_modules) {
                m->stop();
            }
            ULog::info(TAG, "Stopped");
        }

        bool URsm2000Integration::connected() const {
            return std::any_of(m_modules.begin(), m_modules.end(),
                [](const auto& m) { return m->connected(); });
        }

        std::vector<int> URsm2000Integration::protocol_versions() const {
            std::vector<int> all;
            for (const auto& m : m_modules) {
                for (int v : m->protocol_versions()) {
                    if (std::find(all.begin(), all.end(), v) == all.end()) {
                        all.push_back(v);
                    }
                }
            }
            std::sort(all.begin(), all.end());
            return all;
        }

        // Кадр уходит во все модули: WebSocket и CAN — независимые каналы, и
        // молчание одного не должно мешать другому. Ответ ingress'у сводим так:
        // доставка хотя бы одним каналом — это успех, потому что media-center по
        // этому ответу решает только, слать ли дальше.
        FSubmitResult URsm2000Integration::handle_frame(const FFrameMessage& msg) {
            FSubmitResult combined;
            combined.ver = msg.ver;

            bool any_accepted = false;
            std::string transports;
            std::string errors;
            bool all_unsupported = true;

            for (const auto& m : m_modules) {
                const FSubmitResult r = m->handle_frame(msg);

                if (r.status == ESubmitStatus::Accepted) {
                    any_accepted = true;
                    all_unsupported = false;
                    combined.wire_size += r.wire_size;
                    if (!transports.empty()) transports += "+";
                    transports += r.transport.empty() ? m->transport() : r.transport;
                    continue;
                }

                if (r.status != ESubmitStatus::UnsupportedVersion) {
                    all_unsupported = false;
                }
                if (!errors.empty()) errors += "; ";
                errors += m->id() + ": " + r.error;

                if (r.status == ESubmitStatus::UnsupportedVersion && combined.supported.empty()) {
                    combined.supported = r.supported;
                }
            }

            if (any_accepted) {
                combined.status = ESubmitStatus::Accepted;
                combined.transport = transports;
                return combined;
            }

            // Ни один канал не взял кадр. Версию протокола выделяем отдельно:
            // media-center по ней понимает, что дело не в связи, а в контракте.
            combined.status = all_unsupported
                ? ESubmitStatus::UnsupportedVersion
                : ESubmitStatus::NotConnected;
            combined.error = errors.empty() ? "no delivery modules" : errors;
            return combined;
        }

        boost::json::object URsm2000Integration::config_json() const {
            json::array modules;
            for (const auto& m : m_modules) {
                modules.push_back(m->to_json());
            }

            json::object o;
            o["id"] = id();
            o["title"] = title();
            o["description"] = description();
            o["modules"] = std::move(modules);
            return o;
        }

        boost::json::object URsm2000Integration::status_json() const {
            return config_json();
        }

    } // namespace gateway
} // namespace varan
