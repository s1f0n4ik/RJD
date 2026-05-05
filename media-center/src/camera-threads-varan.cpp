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
	std::signal(SIGINT, signal_handler);

	AppConfig config;
	ULogger main_logger = ULogger("MAIN", ULogger::ELoggerLevel::DEBUG);

	if (!parse_arguments(argc, argv, config)) {
		return EXIT_FAILURE;
	}

	setenv("GST_GL_PLATFORM", "egl", 1);
	setenv("GST_GL_API", "gles2", 1);
	//setenv("GST_DEBUG", "*:4,rtph265depay:0,rtph264depay:0", 1);
	gst_init(nullptr, nullptr);
	gst_debug_set_active(TRUE);
	//gst_debug_set_default_threshold(GST_LEVEL_INFO);

	main_logger.info((std::ostringstream() << "GStreamer version: "
		<< GST_VERSION_MAJOR << "."
		<< GST_VERSION_MINOR << "."
		<< GST_VERSION_MICRO).str());
	main_logger.info((std::ostringstream() << "REST port: " << config.rest_port).str());
	main_logger.info((std::ostringstream() << "Signaling: " << config.signaling_ip << ":" << config.signaling_port).str());

	auto socket_options = varan::nvr::FWebSocketOptions(config.signaling_ip, std::to_string(config.signaling_port));

	// Контекст и хранидище для OpenGL
	auto gl_storage = std::make_shared<FFrameStorage<IFrame>>(&main_logger);
	auto main_context = std::make_shared<varan::birdview::UEGLContextManager>();
	main_context->init(true, &main_logger);

	// Создание модуля 360
	//auto linker_360 = std::make_shared<varan::birdview::ULinker>(socket_options, main_context.get(), gl_storage.get(), ULogger::ELoggerLevel::TRACE);
	//linker_360->set_stitching_mode(varan::birdview::EBirdViewStitchingMode::SIX_CAMERAS);

	// Создание калибратора
	auto calibrator = std::make_shared<varan::calibration::UCalibrator>(socket_options.ip_adress, socket_options.port, main_context.get(), gl_storage.get());
	calibrator->start_websocket_connection();

	// Создание центра видеонаблюдения
	auto center = std::make_shared<varan::neural::UMediaCenter>(socket_options, main_context.get());
	center->set_bird_view_callback(std::move(gl_storage->get_callback()));
	//center->set_neural_callback(std::move(linker_360.get_dmabuf_frame_callback()));

	auto rest_server = URestServer{ config.rest_port, center };
	rest_server.async_start();

	// camera 1
	FPipelineData main_1;
	main_1.name = "main"; main_1.type = EPilelineType::MAIN; main_1.rtsp_url = "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/101";
	main_1.latency = 0; main_1.use_udp = false; main_1.reconnect_time = 10;
	main_1.record_path = "/home/orangepi/records/camera_01"; main_1.segment_length = 10;

	FPipelineData sub_1;
	sub_1.name = "sub"; sub_1.type = EPilelineType::SUB; sub_1.rtsp_url = "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/102";
	sub_1.latency = 0; sub_1.use_udp = true; sub_1.reconnect_time = 10;

	// camera 2
	FPipelineData main_2;
	main_2.name = "main"; main_2.type = EPilelineType::MAIN; main_2.rtsp_url = "rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/101";
	main_2.latency = 0; main_2.use_udp = false; main_2.reconnect_time = 10;
	main_2.record_path = "/home/orangepi/records/camera_02"; main_2.segment_length = 10;

	FPipelineData sub_2;
	sub_2.name = "sub"; sub_2.type = EPilelineType::SUB; sub_2.rtsp_url = "rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/102";
	sub_2.latency = 0; sub_2.use_udp = true; sub_2.reconnect_time = 10;

	// camera 3
	FPipelineData main_3;
	main_3.name = "main"; main_3.type = EPilelineType::MAIN; main_3.rtsp_url = "rtsp://admin:VniiTest@192.168.1.13:554/cam/realmonitor?channel=1&subtype=0";
	main_3.latency = 0; main_3.use_udp = false; main_3.reconnect_time = 10;
	main_3.record_path = "/home/orangepi/records/camera_03"; main_3.segment_length = 10;

	FPipelineData sub_3;
	sub_3.name = "sub"; sub_3.type = EPilelineType::SUB; sub_3.rtsp_url = "rtsp://admin:VniiTest@192.168.1.13:554/cam/realmonitor?channel=1&subtype=1";
	sub_3.latency = 0; sub_3.use_udp = true; sub_3.reconnect_time = 10;

	// camera 4
	FPipelineData main_4;
	main_4.name = "main"; main_4.type = EPilelineType::MAIN; main_4.rtsp_url = "rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=0";
	main_4.latency = 0; main_4.use_udp = false; main_4.reconnect_time = 10;
	main_4.record_path = "/home/orangepi/records/camera_04"; main_4.segment_length = 10;

	FPipelineData sub_4;
	sub_4.name = "sub"; sub_4.type = EPilelineType::SUB; sub_4.rtsp_url = "rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=1";
	sub_4.latency = 0; sub_4.use_udp = true; sub_4.reconnect_time = 10;

	// camera 5
	FPipelineData main_5;
	main_5.name = "main"; main_5.type = EPilelineType::MAIN; main_5.rtsp_url = "rtsp://admin:VniiTest@192.168.1.16:554/ISAPI/Streaming/Channels/101";
	main_5.latency = 0; main_5.use_udp = false; main_5.reconnect_time = 10;
	main_5.record_path = "/home/orangepi/records/camera_06"; main_5.segment_length = 10;

	FPipelineData sub_5;
	sub_5.name = "sub"; sub_5.type = EPilelineType::SUB; sub_5.rtsp_url = "rtsp://admin:VniiTest@192.168.1.16:554/ISAPI/Streaming/Channels/102";
	sub_5.latency = 0; sub_5.use_udp = true; sub_5.reconnect_time = 10;

	// camera 7
	FPipelineData main_6;
	main_6.name = "main"; main_6.type = EPilelineType::MAIN; main_6.rtsp_url = "rtsp://admin:VniiTest@192.168.1.17:554/cam/realmonitor?channel=1&subtype=0";
	main_6.latency = 0; main_6.use_udp = false; main_6.reconnect_time = 10;
	main_6.record_path = "/home/orangepi/records/camera_07"; main_6.segment_length = 10;

	FPipelineData sub_6;
	sub_6.name = "sub"; sub_6.type = EPilelineType::SUB; sub_6.rtsp_url = "rtsp://admin:VniiTest@192.168.1.17:554/cam/realmonitor?channel=1&subtype=1";
	sub_6.latency = 0; sub_6.use_udp = true; sub_6.reconnect_time = 10;

	// camera 8
	FPipelineData main_7;
	main_7.name = "main"; main_7.type = EPilelineType::MAIN; main_7.rtsp_url = "rtsp://admin:VniiTest@192.168.1.18:554/cam/realmonitor?channel=1&subtype=0";
	main_7.latency = 0; main_7.use_udp = false; main_7.reconnect_time = 10;
	main_7.record_path = "/home/orangepi/records/camera_08"; main_7.segment_length = 10;

	FPipelineData sub_7;
	sub_7.name = "sub"; sub_7.type = EPilelineType::SUB; sub_7.rtsp_url = "rtsp://admin:VniiTest@192.168.1.18:554/cam/realmonitor?channel=1&subtype=1";
	sub_7.latency = 0; sub_7.use_udp = true; sub_7.reconnect_time = 10;

	// camera 9
	FPipelineData main_8;
	main_8.name = "main"; main_8.type = EPilelineType::MAIN; main_8.rtsp_url = "rtsp://admin:VniiTest@192.168.1.19:554/ISAPI/Streaming/Channels/101";
	main_8.latency = 0; main_8.use_udp = false; main_8.reconnect_time = 10;
	main_8.record_path = "/home/orangepi/records/camera_09"; main_8.segment_length = 10;

	FPipelineData sub_8;
	sub_8.name = "sub"; sub_8.type = EPilelineType::SUB; sub_8.rtsp_url = "rtsp://admin:VniiTest@192.168.1.19:554/ISAPI/Streaming/Channels/102";
	sub_8.latency = 0; sub_8.use_udp = true; sub_8.reconnect_time = 10;

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
		},{
			{"main", {"", "", "", 1, EPilelineType::MAIN, 0, false, 10, "", 10}},
			{"sub", {"", "", "", 2, EPilelineType::SUB, 0, true, 10, "", 10}}
		},
	};

	std::vector<varan::nvr::FCameraData> vector_options = {
		{"camera_01", "Камера 1", "Описание", "192.168.1.11", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::HIKVISION},
		{"camera_02", "Камера 2", "Описание", "192.168.1.12", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::HIKVISION},
		{"camera_03", "Камера 3", "Описание", "192.168.1.13", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::DAHUA},
		{"camera_04", "Камера 4", "Описание", "192.168.1.14", "554", "admin", "VniiTest", ECameraType::GENERAL, ERtspType::DAHUA},
		//{"camera_06", "Камера 5", "Описание", "192.168.1.16", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::HIKVISION},
		//{"camera_07", "Камера 6", "Описание", "192.168.1.17", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::DAHUA},
		{"camera_10", "Камера 10", "Описание", "192.168.1.31", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::ACE},
		{"camera_11", "Камера 11", "Описание", "192.168.1.32", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::ACE},
		{"camera_bird_test", "Камера Крутая ахуенная", "ХУЙ", "192.168.1.64", "554", "admin", "VniiTest", ECameraType::BIRDVIEW, ERtspType::HIKVISION},
	};

	// Создание камер
	for (size_t i = 0; i < vector_options.size(); ++i) {
		center->add_camera(vector_options[i], streams_config[i < streams_config.size() ? i : streams_config.size() - 1]);
	}

	center->initialize_cameras();

	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::FRONT, "camera_1");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::BACK, "camera_2");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::LEFT_FRONT, "camera_3");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::RIGHT_FRONT, "camera_4");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::RIGHT_BACK, "camera_6");
	//linker_360->set_render_camera(varan::birdview::EBirdCameraType::LEFT_BACK, "camera_7");

	// Запуск камер
	center->start_cameras();

	// Запуск Линкера
	//linker_360->async_start(25);

	while (RUNNING) {
		std::this_thread::sleep_for(std::chrono::milliseconds(200));
	}

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
	if (signal == SIGINT) {
		std::cout << "\nCtrl+C pressed, stopping application..." << std::endl;
		RUNNING = false;
	}
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
