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

#include "shader.h"
#include "utility.h"
#include "egl-context.h"

namespace nvr = varan::nvr;

namespace varan {
namespace birdview {

	class ULinker {
		using NLinkSpace = std::vector<NPFrame>;
		using NCamerasPurpose = std::unordered_map<std::string, std::optional<std::string>>;
	public:

		ULinker(
			const nvr::FWebSocketOptions& websocket,
			UEGLContextManager* context_manager,
			FFrameStorage<IFrame>* storage,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		~ULinker();

		std::vector<std::string> get_active_cameras();

		bool reload_from_state();

		std::vector<std::string> get_camera_keys() const;

		bool set_render_camera(const std::string& key, std::string camera);

		bool async_start(uint32_t fps);

		void stop();

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
	};

}; // birdview
}; // varan