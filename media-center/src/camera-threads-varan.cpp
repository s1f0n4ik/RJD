// camera-threads-varan.cpp: определяет точку входа для приложения.
//
#include <iostream>
#include <filesystem>
#include <charconv>
#include <cstring>
#include <csignal>
#include <sys/resource.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

#include "console_utility.h"
#include "main-server/rest_server.h"
#include "bird-view/linker.h"
#include "bird-view/egl-context.h"
#include "neural/loader.h"

#include "calibration/calibrator.h"

#include "utility/frames.h"

using namespace std;
using namespace varan;

std::atomic<bool> RUNNING{ true };

struct AppConfig {
	uint16_t rest_port;
	std::string signaling_ip;
	uint16_t signaling_port;
};

void signal_handler(int signal);
bool is_valid_ipv4(const std::string& ip);
bool parse_port(const char* str, uint16_t& port_out);
bool parse_arguments(int argc, char* argv[], AppConfig& config, ULogger* logger = nullptr);

int main(int argc, char* argv[])
{
	AppConfig config;
	ULogger main_logger = ULogger("MAIN", ULogger::ELoggerLevel::DEBUG);

	if (!parse_arguments(argc, argv, config)) {
		return EXIT_FAILURE;
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

	auto socket_options = varan::nvr::FWebSocketOptions(config.signaling_ip, std::to_string(config.signaling_port));

	// Контекст и хранилище для OpenGL
	auto gl_storage = std::make_shared<FFrameStorage<IFrame>>(&main_logger);
	auto main_context = std::make_shared<varan::birdview::UEGLContextManager>();
	main_context->init(true, &main_logger);

	// Создание модуля 360
	auto linker_360 = std::make_shared<varan::birdview::ULinker>(socket_options, main_context.get(), gl_storage.get(), 25, ULogger::ELoggerLevel::TRACE);

	// Создание калибратора
	auto calibrator = std::make_shared<varan::calibration::UCalibrator>(socket_options.ip_adress, socket_options.port, main_context.get(), gl_storage.get());
	calibrator->start_websocket_connection();

	// Создание нейронного загрузчика
	auto loader = std::make_shared<varan::neural::UNeuralLoader>(
		socket_options.ip_adress, socket_options.port, 
		main_context.get(), 
		gl_storage.get(),
		"/home/orangepi/varan/neural/configurations.json",
		"/home/orangepi/varan/neural/loader_state.json",
		ULogger::ELoggerLevel::DEBUG
	);

	// Создание центра видеонаблюдения
	//auto center = std::make_shared<varan::neural::UMediaCenter>(socket_options);
	auto center = std::make_shared<varan::neural::UMediaCenter>(socket_options, main_context.get());
	center->set_bird_view_callback(std::move(gl_storage->get_callback()));
	center->set_neural_callback(std::move(gl_storage->get_callback()));

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

	auto rest_server = URestServer{ config.rest_port, center, linker_360, loader };
	rest_server.async_start();

	// Запуск Линкера
	linker_360->async_start();

	center->start_cameras_from_config();

	while (RUNNING) {
		std::this_thread::sleep_for(std::chrono::milliseconds(200));
	}

	rest_server.stop();
	center->run_eos();

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

bool parse_arguments(int argc, char* argv[], AppConfig& config, ULogger* logger) {
	if (argc != 4) {
		if (logger) logger->error("Usage: " + std::string(argv[0]) + " <rest_server_port> <signaling_ip> <signaling_port>\n");
		return false;
	}

	if (!parse_port(argv[1], config.rest_port)) {
		if (logger) logger->error("Invalid REST server port\n");
		return false;
	}

	config.signaling_ip = argv[2];
	if (!is_valid_ipv4(config.signaling_ip)) {
		if (logger) logger->error("Invalid signaling IP address\n");
		return false;
	}

	if (!parse_port(argv[3], config.signaling_port)) {
		if (logger) logger->error("Invalid signaling port\n");
		return false;
	}

	return true;
}
