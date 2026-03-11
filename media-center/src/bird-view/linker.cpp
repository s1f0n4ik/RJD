#include "bird-view/linker.h"

namespace varan {
namespace birdview {

	ULinker::ULinker(
		const nvr::FWebSocketOptions& websocket,
		ULogger::ELoggerLevel level
	)
		: m_logger("Bird ULinker", level)
	{
	}

	bool ULinker::add_camera(const std::string& name) {
		return m_storage.register_storage(name);
	}

	CDmabufMover ULinker::get_dmabuf_frame_callback() {
		return std::move(m_storage.get_callback());
	}

}; // birdview
}; // varan