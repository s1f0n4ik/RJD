#pragma once

#include <algorithm>
#include <atomic>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>

#include "bird-view/output-mode.h"
#include "bird-view/surround-renderer.h"
#include "bird-view/linker-store.h"

namespace varan {
namespace birdview {

	// Пределы кадра surround-вывода: кодек и RGA требуют кратности 16
	inline constexpr int SURROUND_RES_MIN = 256;
	inline constexpr int SURROUND_RES_MAX_W = 3840;
	inline constexpr int SURROUND_RES_MAX_H = 2160;

	inline int clamp_frame_side(double v, int lo, int hi) {
		int i = std::clamp(static_cast<int>(v), lo, hi);
		i = (i + 8) / 16 * 16;
		return std::clamp(i, lo, hi);
	}

	// Флаги живых изменений surround-настроек: пишет REST-поток, читает кадр
	inline constexpr unsigned SURROUND_DIRTY_VISUAL = 1;
	inline constexpr unsigned SURROUND_DIRTY_BAKE = 2;

	/*
		Объёмный вид: чаша, печка UV и живые настройки ручки /linker/surround.

		Владеет USurroundRenderer и всей логикой surround-конфигурации: печкой,
		моделью .glb, dirty-флагами и запросом режима орбиты. Позы камер после
		каждой печки отдаются наружу колбэком публикации.
	*/
	class USurroundOutput : public IOutputMode {
	public:
		using NCamerasPurpose = std::unordered_map<std::string, std::optional<std::string>>;
		using CPosesPublish = std::function<void(std::vector<FSurroundBakedCamera>)>;

		USurroundOutput(
			UEGLContextManager* context,
			ULinkerStore* store,
			std::string export_id,
			NCamerasPurpose bindings,
			std::atomic<unsigned>* dirty,
			std::atomic<int>* orbit_mode_request,
			std::atomic<bool>* orbit_state,
			CPosesPublish publish_poses,
			ULogger* logger);

		bool prepare(int& out_width, int& out_height, std::string& error) override;
		std::vector<std::string> camera_keys() const override { return m_camera_keys; }
		bool apply_live_changes() override;
		void bind_camera(USurroundCamera& camera) override;
		void render_frame(std::vector<NPFrame>& frames, float dt, EGLDisplay display) override;

	private:
		// Единая точка смены режима орбиты: рендер + публикация наружу для статуса
		void set_orbit(bool manual);

		// Лёгкие параметры сцены: и на старте, и на живом изменении ручкой
		void apply_visuals(const boost::json::object& cfg);

		// Печка UV чаши; публикует позы и обновляет состав камер
		bool apply_bake(const boost::json::object& cfg);

	private:
		USurroundRenderer m_renderer;
		UEGLContextManager* m_context;
		ULinkerStore* m_store;
		std::string m_export_id;
		NCamerasPurpose m_bindings;
		std::vector<std::string> m_camera_keys;
		// Файл модели, который сейчас загружен в рендерер
		std::string m_loaded_model_source;

		std::atomic<unsigned>* m_dirty;
		std::atomic<int>* m_orbit_mode_request;
		std::atomic<bool>* m_orbit_state;
		CPosesPublish m_publish_poses;

		int m_out_w = 0;
		int m_out_h = 0;
		ULogger* m_logger;
	};

} // birdview
} // varan
