#pragma once

#include <thread>
#include <atomic>
#include <mutex>
#include <functional>
#include <optional>

#include "constants.h"
#include "utility/frame-storage.h"
#include "logger.h"
#include "utility/data-structs.h"

#include "shader.h"
#include "utility.h"
#include "gl-dmabuf-image.h"

namespace nvr = varan::nvr;

namespace varan {
namespace birdview {

	class ULinker {
		using NLinkSpace = std::vector<std::optional<FDmabufFrame>>;
		using NCamerasPurpose = std::unordered_map<EBirdCameraType, std::optional<std::string>>;
	public:

		ULinker(
			const nvr::FWebSocketOptions& websocket,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		~ULinker();

		void set_stitching_mode(EBirdViewStitchingMode mode);

		std::vector<std::string> get_active_cameras();

		bool set_render_camera(EBirdCameraType type, std::string camera);

		CDmabufMover get_dmabuf_frame_callback();

		bool async_start(uint32_t fps);

		void stop();

	private:
		void processing_loop(uint32_t fps);

		NLinkSpace create_linking_space();

		void fill_linking_space(NLinkSpace& space);



	private:
		FDmabufFrameStorage m_storage;

		NCamerasPurpose m_cameras_purpose;

		std::thread m_worker;
		std::atomic<bool> m_running{ false };

		ULogger m_logger;
	};

}; // birdview
}; // varan