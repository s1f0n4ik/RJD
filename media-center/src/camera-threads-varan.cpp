// camera-threads-varan.cpp: определяет точку входа для приложения.
//
#include <iostream>
#include <filesystem>
#include <charconv>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <system_error>
#include <fcntl.h>
#include <unistd.h>
#include <sys/file.h>
#include <sys/resource.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

#include "console_utility.h"
#include "core/machine-config.h"
#include "core/modules.h"
#include "core/paths.h"
#include "core/time-sync.h"
#include "archive/segment-writer.h"
#include "detection/client.h"
#include "gateway/client.h"
#include "main-server/rest_server.h"
#include "bird-view/linker.h"
#include "bird-view/egl-context.h"
#include "neural/loader.h"
#include "neural/input-editor.h"
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

	// Путь к БД с сешментными записями архивных видел
	std::filesystem::path archive_dir;

	// Опциональные модули сборки; ядро камер включено всегда.
	varan::FModuleSet modules;

	// Опциональное подключение к сервису message-gateway
	bool gateway_enabled = false;
	std::string gateway_ip;
	std::string gateway_port;

	// Опциональное подключение к мастеру обнаружений; пусто — мастер не задан
	std::string detection_ip;
	std::string detection_port;
};

void signal_handler(int signal);
void route_glib_to_logger();
bool hold_instance_lock(ULogger& logger);
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

	varan::init_paths(config.varan_root, config.archive_dir);

	// Создание дерева директорий
	for (const auto& dir : varan::required_directories()) {
		std::error_code ec;
		std::filesystem::create_directories(dir, ec);
		if (ec) {
			main_logger.warn("cannot create " + dir.string() + ": " + ec.message());
		}
	}

	// Второй экземпляр писал бы те же камеры в те же каталоги и ту же базу
	if (!hold_instance_lock(main_logger)) {
		return EXIT_FAILURE;
	}

	{
		std::ostringstream banner;
		banner << "=== media-center start === " << ULogger::timestamp();
		for (int i = 0; i < argc; ++i) banner << ' ' << argv[i];
		ULogger::set_log_dir(varan::paths().logs, banner.str());
		main_logger.info("log files -> " + varan::paths().logs.string());
	}

	// До gst_init: предупреждения GStreamer идут в очередь логгера, а не в терминал
	route_glib_to_logger();

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
	main_logger.info("Detection master: "
		+ (config.detection_ip.empty() ? std::string("disabled") : config.detection_ip + ":" + config.detection_port));
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
	}

	// Создание писателя сегментов
	auto segment_writer = std::make_shared<varan::archive::USegmentWriter>(
		varan::paths().archive / "segments.db", ULogger::ELoggerLevel::DEBUG);
	if (segment_writer->start()) {
		main_logger.info("archive index enabled -> " + varan::paths().archive.string()
			+ " session=" + segment_writer->session_uid());
		main_logger.info("archive write target -> " + varan::paths().write_target.string());
	}
	else {
		main_logger.error("archive index DISABLED: writer start failed at "
			+ varan::paths().archive.string() + " (check permissions and sqlite availability)");
		segment_writer.reset();
	}

	// Клиент шлюза стартует после писателя: первый же ответ шлюза должен лечь
	// точкой времени, иначе сессия останется с якорем по часам этой машины
	if (gateway_client) {
		gateway_client->set_time_callback([segment_writer](const varan::gateway::FGatewayTimeGps& t) {
			varan::time_sync::update(t);
			if (segment_writer) segment_writer->note_time();
		});
		gateway_client->start();
	}

	// Определение железа, идентификатора и сессии устройства
	const auto device_info = varan::detect_device();
	main_logger.info((std::ostringstream()
		<< "Platform: " << device_info.label
		<< " (" << device_info.platform << "), npu_cores=" << device_info.npu_cores
		<< ", device=" << device_info.device_id << ", session=" << device_info.session_id).str());

	auto socket_options = varan::nvr::FWebSocketOptions(config.signaling_ip, std::to_string(config.signaling_port));

	// Контекст и хранилище для OpenGL
	auto gl_storage = std::make_shared<FFrameStorage<IFrame>>(&main_logger);
	auto main_context = std::make_shared<varan::birdview::UEGLContextManager>();
	main_context->init(true, &main_logger);

	// Модуль 360 с калибратором - только при birdview
	std::shared_ptr<varan::birdview::ULinker> linker_360;
	std::shared_ptr<varan::calibration::UCalibrator> calibrator;
	if (config.modules.birdview) {
		linker_360 = std::make_shared<varan::birdview::ULinker>(socket_options, main_context.get(), gl_storage.get(), 25, ULogger::ELoggerLevel::TRACE);

		calibrator = std::make_shared<varan::calibration::UCalibrator>(socket_options.ip_adress, socket_options.port, main_context.get(), gl_storage.get());
		calibrator->start_websocket_connection();
	}

	// Нейронный загрузчик - только при neural
	std::shared_ptr<varan::detection::UDetectionClient> detection_client;
	std::shared_ptr<varan::neural::UNeuralLoader> loader;
	if (config.modules.neural) {
		if (!config.detection_ip.empty()) {
			detection_client = std::make_shared<varan::detection::UDetectionClient>(
				config.detection_ip, config.detection_port, device_info);
			detection_client->start();
		}
		loader = std::make_shared<varan::neural::UNeuralLoader>(
			socket_options.ip_adress, socket_options.port,
			main_context.get(),
			gl_storage.get(),
			varan::paths().neural.config,
			varan::paths().neural.loader_state,
			device_info,
			detection_client,
			ULogger::ELoggerLevel::DEBUG
		);
	}

	// Создание центра видеонаблюдения
	auto center = std::make_shared<varan::neural::UMediaCenter>(socket_options, main_context.get());
	center->set_modules(config.modules);
	// Ставится до создания камер: писателя получает каждая пишущая труба
	center->set_segment_writer(segment_writer);

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
				return [weak_center, camera_id](const std::string& msg) {
					auto c = weak_center.lock();
					if (!c) return;
					if (auto cam = c->get_camera(camera_id)) {
						cam->send_message(msg);
					}
				};
			}
		);

		// Запуск neural
		loader->async_run();
	}

	// Редактор видеопотоков нейронки: пара с фронтом через брокер, вывод neural_editor
	std::shared_ptr<varan::neural::UInputEditor> input_editor;
	if (loader) {
		input_editor = std::make_shared<varan::neural::UInputEditor>(
			socket_options.ip_adress, socket_options.port, main_context.get(), gl_storage.get(), loader);
		input_editor->start_websocket_connection();
	}

	// Конфигурация от мастера: части регистрируют модули, применение — через REST
	auto machine_config = std::make_shared<varan::UMachineConfig>();
	machine_config->register_part("cameras", [center](const boost::json::value& part) {
		return center->apply_cameras(part);
	});
	if (loader) {
		machine_config->register_part("neural", [loader](const boost::json::value& part) {
			return loader->apply_config(part);
		});
	}
	if (linker_360) {
		machine_config->register_part("surround", [linker_360](const boost::json::value& part) {
			return linker_360->apply_config(part);
		});
	}

	auto rest_server = URestServer{ config.rest_port, center, linker_360, loader, machine_config, config.modules, device_info };
	rest_server.async_start();

	// Запуск Линкера
	if (linker_360) {
		linker_360->async_start();
	}

	center->start_cameras_from_config();

	while (RUNNING && !rest_server.failed()) {
		std::this_thread::sleep_for(std::chrono::milliseconds(200));
	}
	if (rest_server.failed()) main_logger.error("shutdown: REST server is down, stopping");

	main_logger.info("shutdown: stopping neural editor");
	if (input_editor) input_editor->stop_websocket_connection();
	main_logger.info("shutdown: stopping rest server");
	rest_server.stop();

	// Потребители кадров гасятся до камер
	if (loader) {
		main_logger.info("shutdown: stopping neural loader");
		loader->stop_async_run();
	}
	if (linker_360) {
		main_logger.info("shutdown: stopping birdview linker");
		linker_360->stop();
	}
	if (calibrator) {
		main_logger.info("shutdown: stopping calibrator");
		calibrator->stop_websocket_connection();
	}

	main_logger.info("shutdown: stopping cameras");
	center->run_eos();

	if (gateway_client) {
		gateway_client->stop();
	}
	if (detection_client) {
		detection_client->stop();
	}

	// Индекс закрываем последним: run_eos() дописывает хвосты фрагментов, и их
	// закрытия должны успеть лечь в базу
	if (segment_writer) segment_writer->stop();

	const bool failed = rest_server.failed();
	main_logger.info("shutdown: done");
	ULogger::shutdown();
	return failed ? EXIT_FAILURE : 0;
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

bool hold_instance_lock(ULogger& logger) {
	const auto path = varan::paths().archive / "media-center.lock";
	// Дескриптор не закрывается: замок держится до конца процесса
	const int fd = ::open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0644);
	if (fd < 0) {
		logger.warn("cannot open instance lock " + path.string() + ": " + std::strerror(errno));
		return true;
	}

	if (::flock(fd, LOCK_EX | LOCK_NB) != 0) {
		char owner[32] = {};
		const ssize_t got = ::pread(fd, owner, sizeof(owner) - 1, 0);
		logger.error("another media-center is running (pid " + std::string(owner, got > 0 ? std::size_t(got) : 0)
			+ "), lock " + path.string());
		::close(fd);
		return false;
	}

	const std::string pid = std::to_string(::getpid());
	if (::ftruncate(fd, 0) != 0 || ::pwrite(fd, pid.data(), pid.size(), 0) < 0) {
		logger.warn("cannot write pid into " + path.string());
	}
	return true;
}

// Текст g_print и g_printerr без завершающего перевода строки
static std::string without_newline(const gchar* text) {
	std::string line = text ? text : "";
	while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
	return line;
}

void route_glib_to_logger() {
	static ULogger glib_logger("GLib", ULogger::ELoggerLevel::DEBUG);

	g_log_set_writer_func(+[](GLogLevelFlags level, const GLogField* fields, gsize n_fields, gpointer) {
		// Фатальное сообщение синхронно в терминал: процесс сейчас прервётся
		if (level & (G_LOG_FLAG_FATAL | G_LOG_LEVEL_ERROR)) {
			return g_log_writer_standard_streams(level, fields, n_fields, nullptr);
		}

		const char* domain = nullptr;
		std::string message;
		for (gsize i = 0; i < n_fields; ++i) {
			const auto* value = static_cast<const char*>(fields[i].value);
			if (g_strcmp0(fields[i].key, "GLIB_DOMAIN") == 0) domain = value;
			else if (g_strcmp0(fields[i].key, "MESSAGE") == 0) {
				message = fields[i].length < 0 ? std::string(value) : std::string(value, std::size_t(fields[i].length));
			}
		}
		if (g_log_writer_default_would_drop(level, domain)) return G_LOG_WRITER_HANDLED;

		const std::string line = std::string(domain ? domain : "glib") + ": " + message;
		if (level & G_LOG_LEVEL_CRITICAL) glib_logger.error(line);
		else if (level & G_LOG_LEVEL_WARNING) glib_logger.warn(line);
		else if (level & (G_LOG_LEVEL_MESSAGE | G_LOG_LEVEL_INFO)) glib_logger.info(line);
		else glib_logger.debug(line);
		return G_LOG_WRITER_HANDLED;
	}, nullptr, nullptr);

	g_set_print_handler(+[](const gchar* text) { glib_logger.info(without_newline(text)); });
	g_set_printerr_handler(+[](const gchar* text) { glib_logger.warn(without_newline(text)); });
}

static void print_usage(const char* exe, ULogger* logger) {
	const std::string text =
		std::string("Usage: ") + exe + " \\\n"
		"    --rest-port=<port> --signaling-ip=<ip> --signaling-port=<port> \\\n"
		"    --varan-root=<dir> \\\n"
		"    [--modules=birdview,neural] \\\n"
		"    [--gateway-ip=<ip> --gateway-port=<port>] \\\n"
		"    [--detection-ip=<ip> --detection-port=<port>] \\\n"
		"    [--archive-dir=<dir>]\n"
		"\n"
		"  --varan-root   working directory: nvr, neural, surround_view\n"
		"  --modules      optional build modules; without the flag it is a pure NVR\n"
		"  --archive-dir  recording index and target.json from storage-service;\n"
		"                 otherwise MC_ARCHIVE_DIR, otherwise /storage/archive\n"
		"  --gateway-*    connection to message-gateway; set both or none\n"
		"  --detection-*  connection to the detection master (neural tracks); set both or none\n";

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
	std::string detection_port_raw;

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
		} else if (name == "archive-dir") {
			config.archive_dir = value;
		} else if (name == "gateway-ip") {
			config.gateway_ip = value;
		} else if (name == "gateway-port") {
			gateway_port_raw = value;
		} else if (name == "detection-ip") {
			config.detection_ip = value;
		} else if (name == "detection-port") {
			detection_port_raw = value;
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

	if (config.detection_ip.empty() != detection_port_raw.empty()) {
		if (logger) logger->error("--detection-ip and --detection-port must be given together");
		return false;
	}

	if (!config.detection_ip.empty()) {
		if (!is_valid_ipv4(config.detection_ip)) {
			if (logger) logger->error("Invalid --detection-ip: " + config.detection_ip);
			return false;
		}

		uint16_t detection_port = 0;
		if (!parse_port(detection_port_raw.c_str(), detection_port)) {
			if (logger) logger->error("Invalid --detection-port: " + detection_port_raw);
			return false;
		}
		config.detection_port = std::to_string(detection_port);
	}

	// Индекс архива: флаг важнее переменной, переменная важнее умолчания
	if (config.archive_dir.empty()) {
		const char* env_dir = std::getenv("MC_ARCHIVE_DIR");
		config.archive_dir = (env_dir && *env_dir)
			? std::filesystem::path(env_dir)
			: std::filesystem::path("/storage/archive");
	}

	return true;
}
