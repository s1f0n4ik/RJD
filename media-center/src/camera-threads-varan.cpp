// camera-threads-varan.cpp: определяет точку входа для приложения.
//
#include <iostream>
#include <filesystem>
#include <charconv>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <system_error>
#include <sys/resource.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

#include "console_utility.h"
#include "core/modules.h"
#include "core/paths.h"
#include "core/time-sync.h"
#include "gateway/client.h"
#include "main-server/rest_server.h"
#include "bird-view/linker.h"
#include "bird-view/egl-context.h"
#include "neural/loader.h"
#include "core/platform.h"

#include "calibration/calibrator.h"

#include "utility/frames.h"

using namespace std;
using namespace varan;

std::atomic<bool> RUNNING{ true };

struct AppConfig {
	uint16_t rest_port = 0;
	std::string signaling_ip;
	uint16_t signaling_port = 0;

	// Корень рабочего каталога: nvr, neural и surround_view кладут данные сюда.
	std::filesystem::path varan_root;

	// Журнал обнаружений живёт на своём томе, отдельно от varan_root.
	std::filesystem::path journal_dir;

	// Опциональные модули сборки; ядро камер включено всегда.
	varan::FModuleSet modules;

	// Опциональное подключение к message-gateway (ingress кадров).
	bool gateway_enabled = false;
	std::string gateway_ip;
	std::string gateway_port;
};

void signal_handler(int signal);
bool is_valid_ipv4(const std::string& ip);
bool parse_port(const char* str, uint16_t& port_out);
bool parse_arguments(int argc, char* argv[], AppConfig& config, ULogger* logger = nullptr);

int main(int argc, char* argv[])
{
	AppConfig config;
	ULogger main_logger = ULogger("MAIN", ULogger::ELoggerLevel::DEBUG);

	// Логгер обязателен: без него неверные аргументы уходили в тишину
	if (!parse_arguments(argc, argv, config, &main_logger)) {
		return EXIT_FAILURE;
	}

	varan::init_paths(config.varan_root, config.journal_dir);

	// Создаём дерево заранее, чтобы отказ по правам был виден при старте,
	// а не через часы работы при первом сохранении конфигурации.
	for (const auto& dir : varan::required_directories()) {
		std::error_code ec;
		std::filesystem::create_directories(dir, ec);
		if (ec) {
			main_logger.warn("cannot create " + dir.string() + ": " + ec.message());
		}
	}

	setenv("GST_GL_PLATFORM", "egl", 1);
	setenv("GST_GL_API", "gles2", 1);
	//setenv("GST_DEBUG", "*:4,rtph265depay:0,rtph264depay:0", 1);
	//setenv("GST_DISABLE_FAULT_HANDLER", "1", 1); // отключаем fault handler GStreamer
	gst_init(nullptr, nullptr);
	//gst_debug_set_default_threshold(GST_LEVEL_INFO);

	gst_debug_set_active(TRUE);

	// Явно перезаписываем после инициализации
	std::signal(SIGINT, signal_handler);
	std::signal(SIGTERM, signal_handler);

	main_logger.info((std::ostringstream() << "GStreamer version: "
		<< GST_VERSION_MAJOR << "."
		<< GST_VERSION_MINOR << "."
		<< GST_VERSION_MICRO).str());
	main_logger.info((std::ostringstream() << "REST port: " << config.rest_port).str());
	main_logger.info((std::ostringstream() << "Signaling: " << config.signaling_ip << ":" << config.signaling_port).str());
	main_logger.info((std::ostringstream() << "Gateway: "
		<< (config.gateway_enabled ? config.gateway_ip + ":" + config.gateway_port : std::string("disabled"))).str());
	main_logger.info("Modules: " + config.modules.to_string());

	// Клиент шлюза общий на процесс: время нужно всем сборкам (имена фрагментов
	// записи), кадры через него шлёт только нейронка
	std::shared_ptr<varan::gateway::UGatewayClient> gateway_client;
	if (config.gateway_enabled && !config.gateway_ip.empty() && !config.gateway_port.empty()) {
		varan::gateway::FGatewayConfig gateway_config;
		gateway_config.enabled = true;
		gateway_config.host = config.gateway_ip;
		gateway_config.port = config.gateway_port;

		gateway_client = std::make_shared<varan::gateway::UGatewayClient>(gateway_config);
		gateway_client->set_time_callback([](const varan::gateway::FGatewayTimeGps& t) {
			varan::time_sync::update(t);
		});
		gateway_client->start();
	}

	// Определяем площадку в самом начале и логируем — дальше передаём в нейронку.
	const auto platform_info = varan::detect_platform();
	main_logger.info((std::ostringstream()
		<< "Platform: " << platform_info.label
		<< " (" << platform_info.platform << "), mode=" << platform_info.mode
		<< ", npu_cores=" << platform_info.npu_cores
		<< ", max_streams=" << platform_info.max_streams).str());

	auto socket_options = varan::nvr::FWebSocketOptions(config.signaling_ip, std::to_string(config.signaling_port));

	// Контекст и хранилище для OpenGL
	auto gl_storage = std::make_shared<FFrameStorage<IFrame>>(&main_logger);
	auto main_context = std::make_shared<varan::birdview::UEGLContextManager>();
	main_context->init(true, &main_logger);

	// Модуль 360 с калибратором — только при birdview
	std::shared_ptr<varan::birdview::ULinker> linker_360;
	std::shared_ptr<varan::calibration::UCalibrator> calibrator;
	if (config.modules.birdview) {
		linker_360 = std::make_shared<varan::birdview::ULinker>(socket_options, main_context.get(), gl_storage.get(), 25, ULogger::ELoggerLevel::TRACE);

		calibrator = std::make_shared<varan::calibration::UCalibrator>(socket_options.ip_adress, socket_options.port, main_context.get(), gl_storage.get());
		calibrator->start_websocket_connection();
	}

	// Нейронный загрузчик — только при neural
	std::shared_ptr<varan::neural::UNeuralLoader> loader;
	if (config.modules.neural) {
		loader = std::make_shared<varan::neural::UNeuralLoader>(
			socket_options.ip_adress, socket_options.port,
			main_context.get(),
			gl_storage.get(),
			varan::paths().neural.config,
			varan::paths().neural.loader_state,
			platform_info,
			gateway_client,
			ULogger::ELoggerLevel::DEBUG
		);
	}

	// Создание центра видеонаблюдения
	auto center = std::make_shared<varan::neural::UMediaCenter>(socket_options, main_context.get());
	center->set_modules(config.modules);

	// Колбэки кадров ставятся только потребляющим модулям
	if (config.modules.birdview) {
		center->set_bird_view_callback(std::move(gl_storage->get_callback()));
		// Поток коррекции birdview-камер читает кадры из того же хранилища
		center->set_frame_storage(gl_storage.get());
	}
	if (config.modules.neural) {
		center->set_neural_callback(std::move(gl_storage->get_callback()));
	}

	if (loader) {
		// Привязываем к нейронке возмодность получать callback для камер
		std::weak_ptr<varan::neural::UMediaCenter> weak_center = center;
		loader->set_sender_provider(
			[weak_center](const std::string& camera_id) -> varan::neural::FCameraMessageSender {
				auto c = weak_center.lock();
				if (!c) return {};

				auto cam = c->get_camera(camera_id);
				if (!cam) return {};

				// weak_ptr на камеру — если камеру удалят пока слот жив,
				// send станет no-op без UB
				std::weak_ptr<varan::neural::UCamera> weak_cam = cam;
				return [weak_cam](const std::string& msg) {
					if (auto cam = weak_cam.lock()) {
						cam->send_message(msg);
					}
				};
			}
		);

		// Запуск neural
		loader->async_run();
	}

	auto rest_server = URestServer{ config.rest_port, center, linker_360, loader, config.modules, platform_info };
	rest_server.async_start();

	// Запуск Линкера
	if (linker_360) {
		linker_360->async_start();
	}

	center->start_cameras_from_config();

	while (RUNNING) {
		std::this_thread::sleep_for(std::chrono::milliseconds(200));
	}

	rest_server.stop();
	center->run_eos();

	if (gateway_client) {
		gateway_client->stop();
	}

	return 0;
}

bool is_valid_ipv4(const std::string& ip)
{
	std::istringstream ss(ip);
	std::string token;
	int count = 0;

	while (std::getline(ss, token, '.')) {
		if (token.empty() || token.size() > 3) {
			return false;
		}

		for (char c : token) {
			if (!std::isdigit(c)) {
				return false;
			}
		}

		int num = std::stoi(token);
		if (num < 0 || num > 255) {
			return false;
		}

		count++;
	}

	return count == 4;
}

bool parse_port(const char* str, uint16_t& port_out)
{
	int value = 0;
	auto [ptr, ec] = std::from_chars(str, str + std::strlen(str), value);

	if (ec != std::errc() || ptr != str + std::strlen(str)) {
		return false;
	}

	if (value <= 0 || value > 65535) {
		return false;
	}

	port_out = static_cast<uint16_t>(value);
	return true;
}

void signal_handler(int signal) {
	std::cout << "\nCtrl+C pressed, stopping application..." << std::endl;
	RUNNING = false;
}

static void print_usage(const char* exe, ULogger* logger) {
	const std::string text =
		std::string("Usage: ") + exe + " \\\n"
		"    --rest-port=<port> --signaling-ip=<ip> --signaling-port=<port> \\\n"
		"    --varan-root=<dir> \\\n"
		"    [--modules=birdview,neural] \\\n"
		"    [--gateway-ip=<ip> --gateway-port=<port>] \\\n"
		"    [--journal-dir=<dir>]\n"
		"\n"
		"  --varan-root   working directory: nvr, neural, surround_view\n"
		"  --modules      optional build modules; without the flag it is a pure NVR\n"
		"  --journal-dir  detection journal; otherwise MC_JOURNAL_DIR, otherwise /storage/journal\n"
		"  --gateway-*    connection to message-gateway; set both or none\n";

	if (logger) logger->error(text);
	else std::cerr << text;
}

// Разбирает --name=value. Возвращает false, если аргумент не такой формы.
static bool split_flag(const char* arg, std::string& name, std::string& value) {
	const std::string text = arg;
	if (text.rfind("--", 0) != 0) return false;

	const auto eq = text.find('=');
	if (eq == std::string::npos) return false;

	name = text.substr(2, eq - 2);
	value = text.substr(eq + 1);
	return !name.empty();
}

bool parse_arguments(int argc, char* argv[], AppConfig& config, ULogger* logger) {
	std::string gateway_port_raw;

	for (int i = 1; i < argc; ++i) {
		std::string name, value;
		if (!split_flag(argv[i], name, value)) {
			if (logger) logger->error("Unexpected argument: " + std::string(argv[i]));
			print_usage(argv[0], logger);
			return false;
		}

		if (name == "rest-port") {
			if (!parse_port(value.c_str(), config.rest_port)) {
				if (logger) logger->error("Invalid --rest-port: " + value);
				return false;
			}
		} else if (name == "signaling-ip") {
			config.signaling_ip = value;
		} else if (name == "signaling-port") {
			if (!parse_port(value.c_str(), config.signaling_port)) {
				if (logger) logger->error("Invalid --signaling-port: " + value);
				return false;
			}
		} else if (name == "varan-root") {
			config.varan_root = value;
		} else if (name == "modules") {
			auto modules = varan::FModuleSet::parse(value);
			if (!modules) {
				if (logger) logger->error("Invalid --modules: " + value + " (known: birdview, neural)");
				return false;
			}
			config.modules = *modules;
		} else if (name == "journal-dir") {
			config.journal_dir = value;
		} else if (name == "gateway-ip") {
			config.gateway_ip = value;
		} else if (name == "gateway-port") {
			gateway_port_raw = value;
		} else {
			if (logger) logger->error("Unknown flag: --" + name);
			print_usage(argv[0], logger);
			return false;
		}
	}

	if (config.rest_port == 0 || config.signaling_ip.empty()
		|| config.signaling_port == 0 || config.varan_root.empty()) {
		if (logger) logger->error(
			"Missing required flags: --rest-port, --signaling-ip, --signaling-port, --varan-root");
		print_usage(argv[0], logger);
		return false;
	}

	if (!is_valid_ipv4(config.signaling_ip)) {
		if (logger) logger->error("Invalid --signaling-ip: " + config.signaling_ip);
		return false;
	}

	// Шлюз опционален, но полурезультат хуже отключённого — требуем оба флага.
	if (config.gateway_ip.empty() != gateway_port_raw.empty()) {
		if (logger) logger->error("--gateway-ip and --gateway-port must be given together");
		return false;
	}

	if (!config.gateway_ip.empty()) {
		if (!is_valid_ipv4(config.gateway_ip)) {
			if (logger) logger->error("Invalid --gateway-ip: " + config.gateway_ip);
			return false;
		}

		uint16_t gateway_port = 0;
		if (!parse_port(gateway_port_raw.c_str(), gateway_port)) {
			if (logger) logger->error("Invalid --gateway-port: " + gateway_port_raw);
			return false;
		}
		config.gateway_port = std::to_string(gateway_port);
		config.gateway_enabled = true;
	}

	// Журнал: флаг важнее переменной, переменная важнее умолчания.
	if (config.journal_dir.empty()) {
		const char* env_dir = std::getenv("MC_JOURNAL_DIR");
		config.journal_dir = (env_dir && *env_dir)
			? std::filesystem::path(env_dir)
			: std::filesystem::path("/storage/journal");
	}

	return true;
}
