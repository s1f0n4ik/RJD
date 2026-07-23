#pragma once

#include <boost/beast/http.hpp>
#include <boost/json.hpp>
#include <memory>
#include <optional>

#include "bird-view/linker.h"
#include "neural/loader.h"

// GET /streams - сборка 360 и нейронные слоты с настроенной трансляцией
// Своего состояния нет, всё спрашивается у линкера и загрузчика
// Калибратор не опрашивается, его виртуальная камера живёт одну вкладку
class UStreamsController {
public:
	UStreamsController(
		std::shared_ptr<varan::birdview::ULinker> linker,
		std::shared_ptr<varan::neural::UNeuralLoader> loader,
		ULogger* logger = nullptr
	);

	boost::beast::http::response<boost::beast::http::string_body>
		get_streams(const boost::beast::http::request<boost::beast::http::string_body>& req);

	// Тот же список без обёртки HTTP, для контроллера камер
	boost::json::array collect();

private:
	// Одна запись: активная конфигурация сборки, запущена или нет
	std::optional<boost::json::object> collect_birdview();

	// По записи на слот с настроенной трансляцией
	boost::json::array collect_neural();

private:
	std::shared_ptr<varan::birdview::ULinker> m_linker;
	std::shared_ptr<varan::neural::UNeuralLoader> m_loader;
	ULogger* m_logger;
};
