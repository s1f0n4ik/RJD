#pragma once

#include <thread>
#include <atomic>
#include <mutex>
#include <functional>
#include <optional>

#include "constants.h"
#include "logger.h"
#include "utility/frames.h"
#include "utility/frame-storage.h"
#include "utility/data-structs.h"

#include <boost/json.hpp>

#include "shader.h"
#include "utility.h"
#include "egl-context.h"
#include "camera.h"

namespace nvr = varan::nvr;

namespace varan {
namespace birdview {

	class ULinker {
		using NLinkSpace = std::vector<NPFrame>;
		using NCamerasPurpose = std::unordered_map<std::string, std::optional<std::string>>;

	public:
		struct FExportInfo {
			std::string id;
			std::string name;
			std::vector<std::string> cameras;
		};

	public:
		ULinker(
			const nvr::FWebSocketOptions& websocket,
			UEGLContextManager* context_manager,
			FFrameStorage<IFrame>* storage,
			uint32_t fps = 25,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		~ULinker();

		std::string get_stream_id() const;

		bool reload_from_state();

		std::vector<std::string> get_camera_keys() const;

		bool set_render_camera(const std::string& key, std::string camera);

		bool async_start();

		void stop();

		bool restart();

		bool is_running() const { return m_running.load(); }

		std::string get_active_export_id() const;

	// Методы для работы с сервером
	public:
		bool write_state(const std::string& export_id, const std::unordered_map<std::string, std::string>& bindings);

		std::vector<FExportInfo> list_exports();
		boost::json::object get_state_raw();

		std::filesystem::path get_configurations_path();
		std::filesystem::path get_images_list_path();

	private:
		void processing_loop(uint32_t fps);

		NLinkSpace create_linking_space();

		void fill_linking_space(NLinkSpace& space);

		bool apply_export(const std::string& export_id, NCamerasPurpose desired_bindings);

	private:
		FFrameStorage<IFrame>* m_storage;
		UEGLContextManager* m_context_manager;

		std::string m_export_id;
		std::vector<std::string> m_camera_keys;
		NCamerasPurpose m_cameras_purpose;

		mutable std::mutex m_mutex;
		std::thread m_worker;
		std::atomic<bool> m_running{ false };

		ULogger m_logger;

		std::filesystem::path m_exports_root;
		std::filesystem::path m_exports_index_json;
		std::filesystem::path m_state_index;

		uint32_t m_fps;

		nvr::FWebSocketOptions m_websocket;
		std::unique_ptr<varan::neural::UVirtualCamera> m_streamer;
		std::string m_stream_id;
	};

}; // birdview
}; // varan