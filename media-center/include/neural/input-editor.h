#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include <boost/json.hpp>

#include "core/websocket-handler.h"
#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"

#include "neural/canvas-composer.h"
#include "neural/loader.h"
#include "neural/video-stream.h"
#include "camera.h"

namespace varan {
namespace neural {

	// Редактор видеопотока: собирает полотно тем же сборщиком, что и слот, и отдаёт его
	// виртуальной камерой neural_editor; раскладка меняется по WS без перезапуска вывода
	class UInputEditor : public UWebSocketHandler {
	public:
		UInputEditor(
			const std::string& ip_address,
			const std::string& port,
			birdview::UEGLContextManager* context,
			FFrameStorage<IFrame>* storage,
			std::shared_ptr<UNeuralLoader> loader,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		~UInputEditor() override;

		void start_websocket_connection();
		void stop_websocket_connection();

	protected:
		void on_signaling_message(const std::string& msg) override;

	private:
		using FErrorSink = std::function<void(const std::string& type, const std::string& err, const std::string* client_id)>;

		void handle_open(const std::string& client_id, const boost::json::object& meta, const FErrorSink& on_error);
		void handle_update(const std::string& client_id, const boost::json::object& meta, const FErrorSink& on_error);
		void handle_close(const std::string& client_id, const std::string& reason);
		void handle_status(const std::string& client_id);

		// Поднимает сборщик и вывод под размер полотна; false — причина в err
		bool open_session(const FVideoStream& stream, int width, int height, int fps, std::string& err);
		void close_session();

		boost::json::object session_meta() const;
		boost::json::array tiles_json() const;
		void touch();
		void watchdog_loop();

	private:
		birdview::UEGLContextManager* m_context;
		FFrameStorage<IFrame>* m_storage;
		std::shared_ptr<UNeuralLoader> m_loader;
		ULogger::ELoggerLevel m_level;
		std::string m_name{ "neural-editor" };

		mutable std::mutex m_session_mutex;
		std::string m_client_id;
		FVideoStream m_stream;
		int m_width = 0;
		int m_height = 0;
		std::unique_ptr<UCanvasComposer> m_composer;
		std::unique_ptr<UVirtualCamera> m_streamer;

		std::atomic<std::chrono::steady_clock::time_point::rep> m_last_activity{ 0 };
		std::thread m_watchdog;
		std::atomic<bool> m_watchdog_running{ false };
		std::condition_variable m_watchdog_cv;
		std::mutex m_watchdog_mutex;
	};

} // namespace neural
} // namespace varan
