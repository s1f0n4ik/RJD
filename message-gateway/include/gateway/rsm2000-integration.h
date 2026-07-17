#pragma once

#include <memory>
#include <vector>
#include <string>

#include <boost/asio.hpp>

#include "gateway/integration.h"
#include "gateway/ws-module.h"
#include "gateway/can-module.h"
#include "gateway/config.h"
#include "gateway/taxonomy.h"
#include "gateway/timesource.h"
#include "gateway/clock.h"

namespace varan {
    namespace gateway {

        // Интеграция РСМ-2000. Набор из двух модулей доставки, работающих
        // одновременно: WebSocket отдаёт кадр с изображением и обнаружениями в
        // КАУС, CAN выкладывает обнаружения на шину изделия и оттуда же
        // синхронизирует время и координаты от Садко.
        //
        // Собственной логики доставки здесь нет — только раздача кадра модулям и
        // сведение их ответов.
        class URsm2000Integration : public IIntegration {
        public:
            URsm2000Integration(boost::asio::io_context& ioc, FWsConfig ws, FCanConfig can,
                int heartbeat_sec, const UTaxonomy& taxonomy, UTimeSource& time_source);

            std::string id() const override { return "rsm-2000"; }
            std::string title() const override { return "РСМ-2000"; }
            std::string description() const override {
                return "Передача обнаружений в АС КРСПС по протоколу v1 через WebSocket "
                    "и на шину CAN (J1939), синхронизация времени и GPS от Садко.";
            }

            std::vector<std::shared_ptr<IModule>> modules() const override { return m_modules; }
            std::shared_ptr<IModule> find_module(const std::string& id) const override;

            void start() override;
            void stop() override;
            bool connected() const override;

            FSubmitResult handle_frame(const FFrameMessage& msg) override;
            std::vector<int> protocol_versions() const override;

            boost::json::object config_json() const override;
            boost::json::object status_json() const override;

        private:
            std::vector<std::shared_ptr<IModule>> m_modules;
        };

    } // namespace gateway
} // namespace varan
