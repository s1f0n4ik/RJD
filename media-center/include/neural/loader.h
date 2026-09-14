#pragma once

#include <opencv2/opencv.hpp>
#include <memory>
#include <atomic>
#include <thread>
#include <condition_variable>
#include <filesystem>
#include <map>
#include <vector>
#include <chrono>

#include <boost/json.hpp>

#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"

#include "neural/json-configurator.h"
#include "neural/slot.h"
#include "neural/matrix.h"
#include "gateway/client.h"
#include "journal/writer.h"
#include "core/platform.h"

#include "logger.h"
#include "camera.h"

#include <functional>

namespace varan {
namespace neural {

	class UNeuralLoader {
	public:
		
		enum class EImportMode {
			MERGE,
			REPLACE_ALL,
		};

		using FCameraSenderProvider = std::function<FCameraMessageSender(const std::string& camera_id)>;

	public:
		UNeuralLoader() = delete;
		UNeuralLoader(
			const std::string& ip_address,
			const std::string& port,
			birdview::UEGLContextManager* context,
			FFrameStorage<IFrame>* storage,
			std::filesystem::path config_path,
			std::filesystem::path state_path,
			FPlatformInfo platform,
			std::shared_ptr<gateway::UGatewayClient> gateway = nullptr,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		~UNeuralLoader();

		bool async_run();
		void stop_async_run();
		bool restart();
		bool is_running() const;

		// Конфигурации
		std::vector<FNeuralExports> list_configurations() const;
		// Полный JSON конкретного конфига (для GET ?id=...).
		boost::json::value get_configuration_full(const std::string& id) const;
		bool import_configurations(const boost::json::value& json, EImportMode mode);
		enum class EDeleteResult { OK, NOT_FOUND, IN_USE, FAILED };
		// Удаляет конфигурацию из файла; занятую слотом state не трогает
		EDeleteResult delete_configuration(const std::string& id);

		// State
		bool write_state(const std::vector<FNeuralCoreConfig>& active);
		boost::json::object get_state_raw() const;
		bool reload_from_state();

		void set_sender_provider(FCameraSenderProvider provider);

		// Геттеры
		std::vector<FNeuralCoreConfig> get_active_descriptors() const;
		struct FSlotStatus {
			std::string config_id;
			FCameraMatrix cameras;
			FCameraLayout camera_layout;
			std::string stream_id;
			// Имя, под которым поток показывается на фронте
			std::string stream_name;
			// Размер кадра в эфире, нули — вывода ещё не было
			int stream_width = 0;
			int stream_height = 0;
			bool running = false;
			int depth = 1;
			int depth_actual = 0;
			int fps_limit = 10;
			std::string layout;
			// Пустой path — модель не загружена
			FModelInfo model;
			// 0 — ошибки нет; иначе код 6xxx и служебный текст
			int code = 0;
			std::string error;
			float infer_ms = 0.f;
			float wait_ms = 0.f;
			float fps = 0.f;
			float detections = 0.f;
			int tracks = 0;
			std::int64_t dropped = 0;
		};
		std::vector<FSlotStatus> get_slots() const;

		std::optional<std::string> find_camera_config(const std::string& camera_id) const;

		const FPlatformInfo& platform() const { return m_platform; }

	private:
		bool start_loader();
		void cleanup_after_failure();
		void supervisor_loop();
		bool load_state();

		// Синхронизированное время для слотов из общего сервиса varan::time_sync;
		// пустой снимок, пока шлюз ни разу не ответил.
		gateway::FGatewayTimeGps current_synced_time() const;

		static FCameraMatrix parse_camera_matrix(const boost::json::value& v);
		static boost::json::array serialize_camera_matrix(const FCameraMatrix& m);
		std::string make_stream_id(const std::string& config_id, const std::string& camera_id) const;

		// Создаёт слот по дескриптору; FNeuralError 6001 — конфигурации нет.
		// Вызывающий держит m_loader_mutex
		std::unique_ptr<USlot> make_slot(FNeuralCoreConfig desc);
		// Поднимает слот заново на его месте; вызывается супервизором, когда слот умер на ходу
		void restart_slot(size_t index);

	private:
		UJsonNeuralConfiguration m_json_configurator;
		std::vector<FNeuralCoreConfig> m_active_descs;
		// m_slots[i] отвечает m_active_descs[i]; nullptr — слот не создан, причина в m_failed[i]
		std::vector<std::unique_ptr<USlot>> m_slots;
		std::map<size_t, std::pair<int, std::string>> m_failed;
		// restart() просит супервизор пересобрать слоты по новому состоянию
		std::atomic<bool> m_reload{ false };

		mutable std::mutex m_loader_mutex;
		std::thread m_supervisor;
		std::atomic<bool> m_supervisor_running{ false };
		std::mutex m_supervisor_cv_mutex;
		std::condition_variable m_supervisor_cv;

		std::string m_ip;
		std::string m_port;
		birdview::UEGLContextManager* m_context;
		FFrameStorage<IFrame>* m_storage;
		ULogger::ELoggerLevel m_level;
		std::filesystem::path m_config_path;
		std::filesystem::path m_state_path;
		FPlatformInfo m_platform;
		ULogger m_logger;

		FCameraSenderProvider m_sender_provider;

		// Общий клиент message-gateway процесса: создаётся и живёт в main,
		// загрузчик только шлёт через него кадры.
		std::shared_ptr<gateway::UGatewayClient> m_gateway;

		// Writer журнала обнаружений: один на загрузчик, общий для всех слотов.
		// nullptr — журнал не поднялся (ошибка БД), слоты работают без записи.
		std::unique_ptr<journal::UJournalWriter> m_journal;

	};

} // namespace neural
} // namespace varan