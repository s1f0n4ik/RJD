// camera-threads-varan.cpp: определяет точку входа для приложения.
//
#include <iostream>
#include <filesystem>
#include <charconv>
#include <cstring>
#include <csignal>
#include <sys/resource.h>

#include "console_utility.h"
#include "main-server/rest_server.h"
#include "bird-view/linker.h"

using namespace std;

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

std::atomic<bool> RUNNING{ true };

void signal_handler(int signal) {
	if (signal == SIGINT) {
		std::cout << "\nCtrl+C pressed, stopping application..." << std::endl;
		RUNNING = false;
	}
}

int main(int argc, char* argv[])
{
	std::signal(SIGINT, signal_handler);

	if (argc != 4) {
		std::cerr << "Usage: " << argv[0]
			      << " <rest_server_port> <signaling_ip> <signaling_port>\n";
		return EXIT_FAILURE;
	}

	uint16_t rest_port;
	uint16_t signaling_port;

	if (!parse_port(argv[1], rest_port))
	{
		std::cerr << "Invalid REST server port\n";
		return EXIT_FAILURE;
	}

	std::string signaling_ip = argv[2];
	if (!is_valid_ipv4(signaling_ip))
	{
		std::cerr << "Invalid signaling IP address\n";
		return EXIT_FAILURE;
	}

	if (!parse_port(argv[3], signaling_port))
	{
		std::cerr << "Invalid signaling port\n";
		return EXIT_FAILURE;
	}

	//setenv("GST_DEBUG", "*:5", 1);
	gst_init(nullptr, nullptr);
	gst_debug_set_active(TRUE);
	//gst_debug_set_default_threshold(GST_LEVEL_INFO);

	std::cout << "GStreamer version: "
		      << GST_VERSION_MAJOR << "."
		      << GST_VERSION_MINOR << "."
		      << GST_VERSION_MICRO << std::endl;

	std::cout << "REST port: " << rest_port << "\n";
	std::cout << "Signaling: " << signaling_ip << ":" << signaling_port << "\n";

	// Создание модуля 360
	auto linker_360 = varan::birdview::ULinker({"192.168.1.254", "8765"});

	auto media_setting = varan::neural::FMediaSettings{};
	auto center = std::make_shared<varan::neural::UMediaCenter>( media_setting );
	center->set_bird_view_callback(std::move(linker_360.get_dmabuf_frame_callback()));
	//center->set_neural_callback(std::move(linker_360.get_dmabuf_frame_callback()));

	auto rest_server = URestServer{ rest_port, center };
	rest_server.async_start();

	auto socket_options = varan::nvr::FWebSocketOptions(signaling_ip, std::to_string(signaling_port));

	// camera 1
	FPipelineData main_1;
	main_1.name = "main"; main_1.type = EPilelineType::MAIN; main_1.rtsp_url = "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/101";
	main_1.latency = 0; main_1.use_udp = false; main_1.reconnect_time = 10; 
	main_1.record_path = "/home/orangepi/records/camera_01"; main_1.segment_length = 10;

	FPipelineData sub_1;
	sub_1.name = "sub"; sub_1.type = EPilelineType::SUB; sub_1.rtsp_url = "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/102";
	sub_1.latency = 0; sub_1.use_udp = false; sub_1.reconnect_time = 10;

	// camera 2
	FPipelineData main_2;
	main_2.name = "main"; main_2.type = EPilelineType::MAIN; main_2.rtsp_url = "rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/101";
	main_2.latency = 0; main_2.use_udp = false; main_2.reconnect_time = 10;
	main_2.record_path = "/home/orangepi/records/camera_02"; main_2.segment_length = 10;

	FPipelineData sub_2;
	sub_2.name = "sub"; sub_2.type = EPilelineType::SUB; sub_2.rtsp_url = "rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/102";
	sub_2.latency = 0; sub_2.use_udp = false; sub_2.reconnect_time = 10;

	// camera 3
	FPipelineData main_3;
	main_3.name = "main"; main_3.type = EPilelineType::MAIN; main_3.rtsp_url = "rtsp://admin:VniiTest@192.168.1.13:554/cam/realmonitor?channel=1&subtype=0";
	main_3.latency = 0; main_3.use_udp = false; main_3.reconnect_time = 10;
	main_3.record_path = "/home/orangepi/records/camera_03"; main_3.segment_length = 10;

	FPipelineData sub_3;
	sub_3.name = "sub"; sub_3.type = EPilelineType::SUB; sub_3.rtsp_url = "rtsp://admin:VniiTest@192.168.1.13:554/cam/realmonitor?channel=1&subtype=1";
	sub_3.latency = 0; sub_3.use_udp = false; sub_3.reconnect_time = 10;

	// camera 4
	FPipelineData main_4;
	main_4.name = "main"; main_4.type = EPilelineType::MAIN; main_4.rtsp_url = "rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=0";
	main_4.latency = 0; main_4.use_udp = false; main_4.reconnect_time = 10;
	main_4.record_path = "/home/orangepi/records/camera_04"; main_4.segment_length = 10;

	FPipelineData sub_4;
	sub_4.name = "sub"; sub_4.type = EPilelineType::SUB; sub_4.rtsp_url = "rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=1";
	sub_4.latency = 0; sub_4.use_udp = false; sub_4.reconnect_time = 10;

	std::vector<varan::nvr::FCameraData> vector_options = {
		varan::nvr::FCameraData{
			"camera_1", "Test camera", "192.168.1.11", "554", "admin", ECameraType::GENERAL,
			{
				{"main", main_1},
				{"sub", sub_1}
			}
		},
		varan::nvr::FCameraData{
			"camera_2", "Test camera", "192.168.1.12", "554", "admin", ECameraType::GENERAL,
			{
				{"main", main_2},
				{"sub", sub_2}
			}
		},
		varan::nvr::FCameraData{
			"camera_3", "Test camera", "192.168.1.13", "554", "admin", ECameraType::GENERAL,
			{
				{"main", main_3},
				{"sub", sub_3}
			}
		},
		varan::nvr::FCameraData{
			"camera_4", "Test camera", "192.168.1.14", "554", "admin", ECameraType::GENERAL,
			{
				{"main", main_4},
				{"sub", sub_4}
			}
		}
		/*
		varan::neural::FCameraOptions{
			"camera_4",
			"rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=0",
			"/home/orangepi/records/camera_04", 10,
			true, false, true, 25, 32, 1000, 25
		},
		varan::neural::FCameraOptions{
			"camera_5",
			"rtsp://admin:VniiTest@192.168.1.15:554/cam/realmonitor?channel=1&subtype=0",
			"/home/orangepi/records/camera_05", 10,
			true, false, true, 25, 32, 1000, 25
		},
		varan::neural::FCameraOptions{
			"camera_6",
			"rtsp://admin:VniiTest@192.168.1.16:554/ISAPI/Streaming/Channels/101",
			"/home/orangepi/records/camera_06", 10,
			true, false, true, 25, 32, 1000, 25
		},
		varan::neural::FCameraOptions{
			"camera_7",
			"rtsp://admin:VniiTest@192.168.1.17:554/cam/realmonitor?channel=1&subtype=0",
			"/home/orangepi/records/camera_07", 10,
			true, false, true, 25, 32, 1000, 25
		},
		varan::nvr::FCameraData{
			"camera_8", "Test Camera",
			"rtsp://admin:VniiTest@192.168.1.18:554/cam/realmonitor?channel=1&subtype=0", "/home/orangepi/records/camera_08", 10, 200, false,
			"rtsp://admin:VniiTest@192.168.1.18:554/cam/realmonitor?channel=1&subtype=1", 0, true,
			10
		},
		varan::neural::FCameraOptions{
			"camera_9", "Test camera",
			"rtsp://admin:$Admin12345@192.168.1.19:554/ISAPI/Streaming/Channels/101", "/home/orangepi/records/camera_09", 10, 200, false,
			"rtsp://admin:$Admin12345@192.168.1.19:554/ISAPI/Streaming/Channels/102", 0, false,
			10
		},
		// ACE камеры
		varan::neural::FCameraOptions{
			"camera_10", "Test camera",
			"rtsp://admin:$Admin12345@192.168.1.31:554/Streaming/Channels/1", "/home/orangepi/records/camera_10", 10, 200, false,
			"rtsp://192.168.1.31:554/user=admin_password=$Admin12345_channel=0_stream=1&onvif=0.sdp?real_stream", 0, false,
			10
		},
		varan::neural::FCameraOptions{
			"camera_11", "Test camera",
			"rtsp://admin:$Admin12345@192.168.1.32:554/Streaming/Channels/1", "/home/orangepi/records/camera_11", 10, 200, false,
			"rtsp://192.168.1.32:554/user=admin_password=$Admin12345_channel=0_stream=1&onvif=0.sdp?real_stream", 0, false,
			10
		},
		varan::neural::FCameraOptions{
			"camera_12", "Test Analog camera",
			"rtsp://admin:admin1234@192.168.1.108:554/cam/realmonitor?channel=1&subtype=0", "/home/orangepi/records/camera_12", 10, 200, false,
			"rtsp://admin:admin1234@192.168.1.108:554/cam/realmonitor?channel=1&subtype=1", 0, false,
			10
		}
		*/
	};

	// Создание камер
	for (size_t i = 0; i < vector_options.size(); ++i) {
		center->add_camera(vector_options[i], socket_options);
	}

	center->initialize_cameras();

	// Запуск камер
	center->start_cameras();

	while (RUNNING) {
		std::this_thread::sleep_for(std::chrono::milliseconds(200));
	}

	center->run_eos();

	return 0;
}
