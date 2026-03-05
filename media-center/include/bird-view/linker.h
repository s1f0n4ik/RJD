#pragma once

#include "constants.h"
#include "utility/frame-storage.h"
#include "logger.h"
#include "utility/data-structs.h"

namespace nvr = varan::nvr;

namespace varan {
namespace birdview {

	class ULinker {
	public:

		ULinker(
			const nvr::FWebSocketOptions& websocket,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		bool add_camera(const std::string& name);

		CDmabufMover get_dmabuf_frame_callback();

	private:
		FDmabufFrameStorage m_storage;

		ULogger m_logger;
	};

}; // birdview
}; // varan