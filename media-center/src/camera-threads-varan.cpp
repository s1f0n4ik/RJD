// camera-threads-varan.cpp: определяет точку входа для приложения.
//

#include "camera-threads-varan.h"
#include "media_center.h"

using namespace std;

int main()
{
	auto center = varan::neural::UMediaCenter{25};

	std::vector<varan::neural::FCameraOptions> vector_options = {
		varan::neural::FCameraOptions{
			"camera_1",
			"rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/101",
			true, false, true, 25, 32, 0, 1000, 10
		},
		varan::neural::FCameraOptions{
			"camera_2",
			"rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/101",
			true, false, true, 25, 32, 0, 1000, 10
		},
		varan::neural::FCameraOptions{
			"camera_3",
			"rtsp://admin:VniiTest@192.168.1.13:554/cam/realmonitor?channel=1&subtype=0",
			true, false, true, 25, 32, 0, 1000, 10
		},
		varan::neural::FCameraOptions{
			"camera_4",
			"rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=0",
			true, false, true, 25, 32, 0, 1000, 10
		}
	};

	// Создание камер
	for (size_t i = 0; i < vector_options.size(); ++i) {
		center.add_camera(vector_options[i]);
	}

	center.initialize_all();
	center.start_all();

	while (true) {
		center.print_status_line();
		std::this_thread::sleep_for(std::chrono::milliseconds(33));
	}

	std::cout << "Press Enter to stop...\n";
	std::string line;
	std::getline(std::cin, line);

	center.stop_all();

	return 0;
}
