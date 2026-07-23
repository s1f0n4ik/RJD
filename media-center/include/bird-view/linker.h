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

		// Параметры запуска. Свои у каждой конфигурации: имя вывода описывает
		// то, что в нём показано, и при смене конфигурации меняется вместе с ней.
		struct FStreamParams {
			uint32_t fps = 0;             // 0 — взять значение из конфига процесса
			std::string stream_id;        // пусто — VIRTUAL_CAMERA_ID
			std::string stream_name;
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

		FStreamParams get_stream_params() const;

		std::string get_stream_name() const;

	// Методы для работы с сервером
	public:
		bool write_state(
			const std::string& export_id,
			const std::unordered_map<std::string, std::string>& bindings,
			const FStreamParams& params
		);

		// Удаление конфигурации целиком: запись индекса, каталог карт и настройки.
		// Активную удалить нельзя — её файлы читает работающий поток.
		bool delete_export(const std::string& export_id, std::string& error);

		std::vector<FExportInfo> list_exports();
		boost::json::object get_state_raw();

		// Пресеты проекции. Не путать с индексом экспортов: это разные файлы
		std::filesystem::path get_configurations_path();

		// Индекс stitching-экспортов, из которого берутся конфигурации вывода
		std::filesystem::path get_exports_index_path() const;

		std::filesystem::path get_images_list_path();

	private:
		void processing_loop(uint32_t fps);

		NLinkSpace create_linking_space();

		void fill_linking_space(NLinkSpace& space);

		bool apply_export(const std::string& export_id, NCamerasPurpose desired_bindings);

		std::filesystem::path state_path() const;

		// Чтение состояния с приведением старого формата из одной записи к словарю
		boost::json::object read_state_root() const;

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

		// fps из конфига процесса. Служит значением по умолчанию, когда
		// у конфигурации своего не задано
		uint32_t m_fps;

		FStreamParams m_params;

		nvr::FWebSocketOptions m_websocket;
		std::unique_ptr<varan::neural::UVirtualCamera> m_streamer;
		std::string m_stream_id;
	};

}; // birdview
}; // varan