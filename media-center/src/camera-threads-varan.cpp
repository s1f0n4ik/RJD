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

	// Создание центра видеонаблюдения
	//auto center = std::make_shared<varan::neural::UMediaCenter>(socket_options);
	auto center = std::make_shared<varan::neural::UMediaCenter>(socket_options, main_context.get());
	center->set_bird_view_callback(std::move(gl_storage->get_callback()));
	//center->set_neural_callback(std::move(linker_360.get_dmabuf_frame_callback()));

	auto rest_server = URestServer{ config.rest_port, center, linker_360 };
	rest_server.async_start();

	/*
	std::vector<std::map<std::string, FPipelineConfig>> streams_config = {
		{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "/home/orangepi/records/camera_01", 60}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		}, {
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "/home/orangepi/records/camera_02", 60}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		},{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "/home/orangepi/records/camera_03", 60}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		},{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "/home/orangepi/records/camera_04", 60}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		},{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "/home/orangepi/records/camera_10", 60}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		},{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "/home/orangepi/records/camera_11", 60}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		},{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "", 10}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		},
		{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "", 10}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		},
		{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "/home/orangepi/records", 10}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		}
	};

	std::vector<varan::nvr::FCameraData> vector_options = {
		{"camera_01", "Камера 1", "Описание", "192.168.1.11", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::HIKVISION},
		{"camera_02", "Камера 2", "Описание", "192.168.1.12", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::HIKVISION},
		{"camera_03", "Камера 3", "Описание", "192.168.1.13", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::DAHUA},
		{"camera_04", "Камера 4", "Описание", "192.168.1.14", "554", "admin", "VniiTest", ECameraType::GENERAL, ERtspType::DAHUA},
		{"camera_06", "Камера 5", "Описание", "192.168.1.16", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::HIKVISION},
		{"camera_07", "Камера 6", "Описание", "192.168.1.17", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::DAHUA},
		{"camera_10", "Камера 10", "Описание", "192.168.1.31", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::ACE},
		{"camera_11", "Камера 11", "Описание", "192.168.1.32", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::ACE},
		{"camera_bird_test", "Камера апельсинчик", "Для теста калибровки", "192.168.1.64", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::HIKVISION}
	};

	// Создание камер
	for (size_t i = 0; i < vector_options.size(); ++i) {
		center->add_camera(vector_options[i], streams_config[i < streams_config.size() ? i : streams_config.size() - 1]);
	}

	center->initialize_cameras();

	// Запуск камер
	center->start_cameras();

	*/

	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::FRONT, "camera_1");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::BACK, "camera_2");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::LEFT_FRONT, "camera_3");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::RIGHT_FRONT, "camera_4");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::RIGHT_BACK, "camera_6");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::LEFT_BACK, "camera_7");

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
