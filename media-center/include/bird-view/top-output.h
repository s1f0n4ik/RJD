#pragma once

#include <filesystem>

#include "bird-view/output-mode.h"
#include "bird-view/renderer.h"

namespace varan {
namespace birdview {

	// Плоская сшивка сверху: карты remap и weight из экспорта конфигуратора
	class UTopOutput : public IOutputMode {
	public:
		UTopOutput(
			UEGLContextManager* context,
			std::filesystem::path exports_root,
			std::filesystem::path exports_index,
			std::string export_id,
			int rotation_degrees,
			ULogger* logger);

		bool prepare(int& out_width, int& out_height, std::string& error) override;
		std::vector<std::string> camera_keys() const override;
		void render_frame(std::vector<NPFrame>& frames, float dt, EGLDisplay display) override;

	private:
		UStitchRenderer m_renderer;
		UEGLContextManager* m_context;
		std::filesystem::path m_exports_root;
		std::filesystem::path m_exports_index;
		std::string m_export_id;
		int m_rotation_degrees;
		ULogger* m_logger;
	};

} // birdview
} // varan
