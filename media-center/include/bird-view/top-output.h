#pragma once

#include <atomic>
#include <filesystem>
#include <string>

#include "bird-view/output-mode.h"
#include "bird-view/renderer.h"
#include "bird-view/linker-store.h"

namespace varan {
namespace birdview {

	// Флаги живых изменений top-настроек: пишет REST-поток, читает кадр
	inline constexpr unsigned TOP_DIRTY_VISUAL = 1;
	inline constexpr unsigned TOP_DIRTY_WEIGHTS = 2;

	/*
		Плоская сшивка сверху: карты активной версии экспорта плюс сцена
		и фотонормализация из top-блока записи. Всё новое живёт только на
		версиях текущего поколения печки - легаси v1 рисуется как раньше.
	*/
	class UTopOutput : public IOutputMode {
	public:
		UTopOutput(
			UEGLContextManager* context,
			ULinkerStore* store,
			std::string export_id,
			int rotation_degrees,
			std::atomic<unsigned>* dirty,
			ULogger* logger);

		bool prepare(int& out_width, int& out_height, std::string& error) override;
		std::vector<std::string> camera_keys() const override;
		bool apply_live_changes() override;
		void render_frame(std::vector<NPFrame>& frames, float dt, EGLDisplay display) override;

	private:
		// Лёгкие параметры: сцена, модель, подложка, фотонормализация
		void apply_visuals(const boost::json::object& cfg);

		// Пары точек фотонормализации из карт активной версии на диске
		void rebuild_photo_pairs();

	private:
		UStitchRenderer m_renderer;
		UEGLContextManager* m_context;
		ULinkerStore* m_store;
		std::string m_export_id;
		int m_rotation_degrees;
		std::atomic<unsigned>* m_dirty;

		// Поколение активной версии; новые возможности только со второго
		int m_generation = 1;
		std::filesystem::path m_maps_dir;
		// Файл модели, который сейчас загружен в рендерер
		std::string m_loaded_model_source;

		ULogger* m_logger;
	};

} // birdview
} // varan
