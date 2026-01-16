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

void start_server(std::shared_ptr<varan::neural::USignalingServer> server, std::string adress = IP_ADDRESS, int port = PORT);

int main()
{
	/*
	// Инициализация сервера
	boost::asio::io_context ioc;

	// Удерживаем io_context живым, пока не скажем стоп
	auto work_guard = boost::asio::make_work_guard(ioc);

	// Сервер — shared_ptr, чтобы иметь доступ к нему в другом месте
	auto server = std::make_shared<varan::neural::USignalingServer>(ioc);
	start_server(server);

	// Поток с вызовом run()
	std::thread t([&]() {

		ioc.run();
		std::cout << "[asio] io_context finished\n";
	});

	t.detach();
	*/
	gst_init(nullptr, nullptr);
	gst_debug_set_active(TRUE);
	//gst_debug_set_default_threshold(GST_LEVEL_INFO);

	auto media_setting = varan::neural::FMediaSettings{};
	auto center = varan::neural::UMediaCenter{ media_setting };

	std::vector<varan::neural::FCameraOptions> vector_options = {
		varan::neural::FCameraOptions{
			"camera_1",
			"rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/101",
			true, false, true, 25, 32, 0, 1000, 25
		},
		/*varan::neural::FCameraOptions{
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
		}*/
	};

	// Создание камер
	for (size_t i = 0; i < vector_options.size(); ++i) {

		center.add_camera(vector_options[i]);
	}

	center.initialize_cameras();
	
	/*
	// Регистрируем комнаты в сервере для каждой доступной камеры
	for (const auto& camera : center.get_camera_vector()) {
		camera->start_websocket_client("192.168.1.254", "8765", "/camera/" + camera->get_name());
		//server->register_room_camera(camera);
	}

	// Запуск камер
	center.start_cameras();
	*/

	while (true) {
		std::this_thread::sleep_for(std::chrono::seconds(33));
	}

	center.stop_cameras();

	return 0;
}

void start_server(std::shared_ptr<varan::neural::USignalingServer> server, std::string adress, int port) {
	std::cout << color::yellow << "[Media Center] Attempt to start server at "
		<< adress << ":" << port << color::reset << std::endl;
	while (server->start(adress, port) == false) {
		std::cout << color::red << "[Media Center] Attempt failure! Retry in 1 second!\n" << color::reset;
		std::this_thread::sleep_for(std::chrono::milliseconds(1000));
	}
	std::cout << color::green << "[Media Center] Server succesfully started at "
		<< adress << ":" << port << color::reset << '\n' << std::endl;
}
