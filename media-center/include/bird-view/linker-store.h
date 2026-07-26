#pragma once

#include <boost/json.hpp>

#include <filesystem>
#include <functional>
#include <mutex>
#include <optional>
#include <string>

#include "logger.h"

namespace varan {
namespace birdview {

	// Чтение полей json без леса if_contains по месту вызова
	namespace js {

		inline double num(const boost::json::object& o, const char* key, double def) {
			if (auto* v = o.if_contains(key); v && v->is_number()) return v->to_number<double>();
			return def;
		}

		inline std::string str(const boost::json::object& o, const char* key,
			const std::string& def = {}) {
			if (auto* v = o.if_contains(key); v && v->is_string()) return v->as_string().c_str();
			return def;
		}

		inline bool flag(const boost::json::object& o, const char* key, bool def) {
			if (auto* v = o.if_contains(key); v && v->is_bool()) return v->as_bool();
			return def;
		}

		inline const boost::json::object* obj(const boost::json::object& o, const char* key) {
			if (auto* v = o.if_contains(key); v && v->is_object()) return &v->as_object();
			return nullptr;
		}

		inline const boost::json::array* arr(const boost::json::object& o, const char* key) {
			if (auto* v = o.if_contains(key); v && v->is_array()) return &v->as_array();
			return nullptr;
		}

	} // js

	/*
		Диск линкера: state.json и индекс stitching-экспортов.

		Только файловая работа: чтение, точечные правки под замками, миграция
		старого формата состояния. Бизнес-правил здесь нет — что и когда писать,
		решает ULinker. Замки свои на каждый файл: REST-поток и цикл кадра
		ходят к ним одновременно.
	*/
	class ULinkerStore {
	public:
		ULinkerStore(
			std::filesystem::path exports_root,
			std::filesystem::path exports_index,
			std::filesystem::path state_root,
			std::filesystem::path state_index,
			ULogger* logger);

		std::filesystem::path exports_root() const { return m_exports_root; }
		std::filesystem::path exports_index_file() const { return m_exports_index; }
		std::filesystem::path exports_index_path() const { return m_exports_root / m_exports_index; }
		std::filesystem::path state_path() const { return m_state_root / m_state_index; }

		/*
			Состояние — словарь по export_id:

			{
				"active": "<export_id>",
				"configs": { "<export_id>": { "cameras": {...}, "fps": 15, ... } }
			}

			Старый формат из одной записи { export_id, cameras } приводится к
			этому виду: иначе обновление потеряло бы настроенные привязки.
		*/
		boost::json::object read_state() const;

		// Точечная правка записи конфигурации; активную запись меняет только
		// set_active - остальные ручки соседние конфигурации не трогают
		bool mutate_state_entry(const std::string& export_id,
			const std::function<void(boost::json::object&)>& mutate,
			bool set_active, std::string& error);

		// Удаление записи конфигурации; активная сбрасывается, если совпала
		bool erase_state_entry(const std::string& export_id, std::string& error);

		// --- Индекс экспортов ---

		boost::json::object read_exports_root() const;

		std::optional<boost::json::object> read_export_entry(const std::string& export_id) const;

		std::optional<boost::json::object> read_surround_cfg(const std::string& export_id) const;

		// Мёрж surround-блока записи: чтение, правка и запись под одним замком
		bool mutate_surround_block(const std::string& export_id,
			const std::function<bool(boost::json::object&, std::string&)>& mutate,
			std::string& error);

		// Удаление записи из индекса; отсутствие записи или индекса - ошибка
		bool erase_export_entry(const std::string& export_id, std::string& error);

	private:
		// Пустой объект при любой беде: отсутствие файла не отличается от мусора
		boost::json::object read_json_object(const std::filesystem::path& path) const;

		bool write_json_object(const std::filesystem::path& path,
			const boost::json::object& root, std::string& error);

		boost::json::object read_state_unlocked() const;

	private:
		std::filesystem::path m_exports_root;
		std::filesystem::path m_exports_index;
		std::filesystem::path m_state_root;
		std::filesystem::path m_state_index;

		mutable std::mutex m_state_mutex;
		mutable std::mutex m_exports_mutex;

		ULogger* m_logger;
	};

} // birdview
} // varan
