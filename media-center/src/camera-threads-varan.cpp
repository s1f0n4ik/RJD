// camera-threads-varan.cpp: определяет точку входа для приложения.
//
#include <iostream>
#include <filesystem>

#include <sys/resource.h>

#include "media_center.h"
#include "console_utility.h"

using namespace std;
const std::string IP_ADDRESS = "0.0.0.0";
const int PORT = 1111;

int main()
{
	//setenv("GST_DEBUG", "queue:6", 1);
	gst_init(nullptr, nullptr);
	gst_debug_set_active(TRUE);
	//gst_debug_set_default_threshold(GST_LEVEL_INFO);

	auto media_setting = varan::neural::FMediaSettings{};
	auto center = varan::neural::UMediaCenter{ media_setting };

	auto socket_options = varan::neural::FWebSocketOptions("192.168.1.254", "8765");

	std::vector<varan::neural::FCameraOptions> vector_options = {
		/*
		varan::neural::FCameraOptions{
			"camera_1",
			"rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/101",
			"/home/orangepi/records/camera_01", 10,
			true, false, true, 25, 32, 1000, 25
		},
		varan::neural::FCameraOptions{
			"camera_2",
			"rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/101",
			"/home/orangepi/records/camera_02", 10,
			true, false, true, 25, 32, 1000, 25
		},
		varan::neural::FCameraOptions{
			"camera_3",
			"rtsp://admin:VniiTest@192.168.1.13:554/cam/realmonitor?channel=1&subtype=0",
			"/home/orangepi/records/camera_03", 10,
			true, false, true, 25, 32, 1000, 25
		},
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
		varan::neural::FCameraOptions{
			"camera_8",
			"rtsp://admin:VniiTest@192.168.1.18:554/cam/realmonitor?channel=1&subtype=0",
			"/home/orangepi/records/camera_08", 10,
			true, false, true, 25, 32, 1000, 25
		},
		*/
		varan::neural::FCameraOptions{
			"camera_9", "Test camera",
			"rtsp://admin:$Admin12345@192.168.1.19:554/ISAPI/Streaming/Channels/101", "/home/orangepi/records/camera_09", 10, 200, false,
			"rtsp://admin:$Admin12345@192.168.1.19:554/ISAPI/Streaming/Channels/102", 0, true,
			10
		},
		// ACE камеры
		varan::neural::FCameraOptions{
			"camera_10", "Test camera",
			"rtsp://admin:$Admin12345@192.168.1.31:554/Streaming/Channels/1", "/home/orangepi/records/camera_10", 10, 200, false,
			"rtsp://admin:$Admin12345@192.168.1.31:554/Streaming/Channels/2", 0, true,
			10
		},
		varan::neural::FCameraOptions{
			"camera_11", "Test camera",
			"rtsp://admin:$Admin12345@192.168.1.32:554/Streaming/Channels/1", "/home/orangepi/records/camera_11", 10, 200, false,
			"rtsp://admin:$Admin12345@192.168.1.32:554/Streaming/Channels/2", 0, true,
			10
		}
	};

	// Создание камер
	for (size_t i = 0; i < vector_options.size(); ++i) {
		center.add_camera(vector_options[i], socket_options);
	}

	center.initialize_cameras();

	// Запуск камер
	center.start_cameras();

	while (true) {
		std::this_thread::sleep_for(std::chrono::seconds(33));
	}

	center.stop_cameras();

	return 0;
}
