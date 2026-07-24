#pragma once

#include <thread>
#include <atomic>
#include <mutex>
#include <functional>
#include <optional>
#include <utility>

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
#include "bird-view/surround-bake.h"

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
			/*
				Поворот вывода против часовой в градусах: 0, 90, 180, 270.
				Отрицательное значение — в состоянии его ещё нет, тогда угол
				выводится из формы канваса по прежнему правилу.
			*/
			int rotation = -1;
			// Режим вывода: top - сшивка сверху, surround - объёмный вид
			// Пусто - в состоянии не задан, работает top
			std::string view_mode;
		};

		// Допустимые углы. Всё остальное ручка отвергает
		static bool is_valid_rotation(int degrees) {
			return degrees == 0 || degrees == 90 || degrees == 180 || degrees == 270;
		}

		static bool is_valid_view_mode(const std::string& mode) {
			return mode == "top" || mode == "surround";
		}

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

		/*
			Угол, с которым конфигурация пойдёт в эфир: из состояния, а если
			его там нет — 0. Ответ живёт здесь один на всех: и запуск, и
			статус должны говорить одно и то же, иначе интерфейс покажет 0,
			а картинка приедет повёрнутой.
		*/
		int resolve_rotation(const std::string& export_id = {}) const;

		// Режим вывода конфигурации: из состояния, иначе top
		std::string resolve_view_mode(const std::string& export_id = {}) const;

		/*
			Размер кадра, который реально уходит в эфир. Больше канваса на
			выравнивание сторон, поэтому его показывают отдельно: иначе при
			разборе размер в потоке не сойдётся с размером в конфигурации.
			Нули — вывод ещё не запускался.
		*/
		std::pair<int, int> get_output_size() const;

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

		/*
			Смена поворота. Пустой export_id — активная конфигурация.

			При 90 и 270 стороны вывода меняются местами, а NV12 создаётся под
			конкретный размер, поэтому живой вывод пересобирается целиком.
		*/
		bool set_rotation(const std::string& export_id, int degrees, std::string& error);

		// Смена режима вывода. Пустой export_id - активная конфигурация
		// Живой вывод пересобирается: размер кадра у режимов разный
		bool set_view_mode(const std::string& export_id, const std::string& mode, std::string& error);

		// Ручной оверрайд позы камеры места в surround-блоке экспорта
		// payload: {position:[x,y,z], yaw, pitch, roll} или {reset:true}
		bool set_surround_camera(const std::string& export_id, const std::string& place_key,
			const boost::json::object& payload, std::string& error);

		// Частичный мёрж surround-блока: machine, bowl, orbit, model,
		// plate, wireframe, photometric. Живой вывод применяет без рестарта
		bool set_surround(const std::string& export_id,
			const boost::json::object& payload, std::string& error);

		// Действующий surround-блок с дефолтами плюс печёные позы камер
		bool get_surround(const std::string& export_id,
			boost::json::object& out, std::string& error);

		std::vector<FExportInfo> list_exports();
		boost::json::object get_state_raw();

		// Пресеты проекции. Не путать с индексом экспортов: это разные файлы
		std::filesystem::path get_configurations_path();

		// Индекс stitching-экспортов, из которого берутся конфигурации вывода
		std::filesystem::path get_exports_index_path() const;

		std::filesystem::path get_images_list_path();

	private:
		void processing_loop(uint32_t fps);

		// Тело вывода для surround-режима, вызывается из processing_loop
		void surround_loop(uint32_t fps);

		NLinkSpace create_linking_space();

		void fill_linking_space(NLinkSpace& space);

		bool apply_export(const std::string& export_id, NCamerasPurpose desired_bindings);

		std::filesystem::path state_path() const;

		// Чтение состояния с приведением старого формата из одной записи к словарю
		boost::json::object read_state_root() const;

		// Мёрж surround-блока экспорта на диске под мутатором
		bool mutate_surround_block(const std::string& target,
			const std::function<bool(boost::json::object&, std::string&)>& mutate,
			std::string& error);

		// Чтение surround-блока экспорта с диска
		std::optional<boost::json::object> read_surround_cfg(const std::string& export_id) const;

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
		// Состояние живёт в своём каталоге: линкер не хранит ничего, кроме него
		std::filesystem::path m_state_root;
		std::filesystem::path m_state_index;

		// fps из конфига процесса. Служит значением по умолчанию, когда
		// у конфигурации своего не задано
		uint32_t m_fps;

		FStreamParams m_params;

		// Выровненный размер кадра, с которым создан текущий вывод
		int m_out_width = 0;
		int m_out_height = 0;

		nvr::FWebSocketOptions m_websocket;
		std::unique_ptr<varan::neural::UVirtualCamera> m_streamer;
		std::string m_stream_id;

		// Живые изменения surround: цикл забирает флаги и перечитывает конфиг
		static constexpr unsigned SURROUND_DIRTY_VISUAL = 1;
		static constexpr unsigned SURROUND_DIRTY_BAKE = 2;
		std::atomic<unsigned> m_surround_dirty{ 0 };
		// Позы последней печки, отдаются ручкой GET /linker/surround
		std::vector<FSurroundBakedCamera> m_surround_cameras;
	};

}; // birdview
}; // varan