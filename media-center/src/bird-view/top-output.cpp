#include "bird-view/top-output.h"
#include "bird-view/utility.h"

namespace varan {
namespace birdview {

	UTopOutput::UTopOutput(
		UEGLContextManager* context,
		std::filesystem::path exports_root,
		std::filesystem::path exports_index,
		std::string export_id,
		int rotation_degrees,
		ULogger* logger)
		: m_context(context)
		, m_exports_root(std::move(exports_root))
		, m_exports_index(std::move(exports_index))
		, m_export_id(std::move(export_id))
		, m_rotation_degrees(rotation_degrees)
		, m_logger(logger)
	{
	}

	bool UTopOutput::prepare(int& out_width, int& out_height, std::string& error) {
		if (!m_renderer.init(0, m_context, m_logger)) {
			error = "stitch renderer init failed";
			return false;
		}

		if (m_export_id.empty()
			|| !m_renderer.load_export(m_exports_root, m_exports_index, m_export_id)) {
			error = "no active export";
			return false;
		}

		// Поворот — параметр конфигурации, из формы канваса он не выводится
		m_renderer.set_rotation(m_rotation_degrees / 90);

		// Стороны округляются вверх до FRAME_ALIGNMENT, картинка растягивается
		out_width = align_frame_side(m_renderer.rotated_width());
		out_height = align_frame_side(m_renderer.rotated_height());
		m_renderer.set_output_size(out_width, out_height);

		if (m_logger) {
			m_logger->info("UTopOutput::prepare(): src="
				+ std::to_string(m_renderer.canvas_width()) + "x"
				+ std::to_string(m_renderer.canvas_height())
				+ ", out=" + std::to_string(out_width) + "x" + std::to_string(out_height)
				+ ", rotation=" + std::to_string(m_rotation_degrees));
			if (out_width != m_renderer.rotated_width()
				|| out_height != m_renderer.rotated_height()) {
				m_logger->warn("UTopOutput::prepare(): output aligned from "
					+ std::to_string(m_renderer.rotated_width()) + "x"
					+ std::to_string(m_renderer.rotated_height()));
			}
		}
		return true;
	}

	std::vector<std::string> UTopOutput::camera_keys() const {
		return m_renderer.ordered_camera_keys();
	}

	void UTopOutput::render_frame(std::vector<NPFrame>& frames, float dt, EGLDisplay display) {
		(void)dt;
		m_renderer.update_textures(frames, display);
		m_renderer.update(0.0f);
		m_renderer.render(1.0f);
	}

} // birdview
} // varan
