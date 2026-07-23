#pragma once

#include <iostream>
#include <fstream>
#include <filesystem>
#include <sstream>
#include <string>
#include <optional>
#include <atomic>
#include <unordered_set>

#include <boost/json.hpp>

#include "logger.h"
#include "json-utils.h"

namespace varan {

	/*
		Базовый класс для работы с конфигурационными json-файлами.

		Хранит boost::json::object, умеет:
			- читать файл (создавать пустой, если его нет);
			- сохранять файл с pretty-print;
			- добавлять / удалять / получать элементы по ключу;
			- фильтровать неизвестные поля по списку POSSIBLE_FIELDS из наследника.

		Наследник обязан:
			- объявить статический набор допустимых полей (allowed_fields());
			- реализовать собственные view-методы, специфичные для своей схемы.
	*/
	class UJsonReaderBase {
	public:
		explicit UJsonReaderBase(ULogger* logger = nullptr) : m_logger(logger) {}

		virtual ~UJsonReaderBase() = default;

		// Чтение файла. Если файла нет — создаёт пустой.
		bool read(const std::filesystem::path& file_path) {
			try {
				if (m_loaded.load()) {
					return true;
				}

				if (!std::filesystem::exists(file_path)) {
					if (!file_path.parent_path().empty()) {
						std::filesystem::create_directories(file_path.parent_path());
					}

					m_json = boost::json::object{};
					std::ofstream create_file(file_path);
					if (!create_file.is_open()) {
						throw std::runtime_error("cannot create json file: " + file_path.string());
					}

					create_file << boost::json::serialize(m_json);
					log_warn("read(): json file not found, new created: " + file_path.string());
					m_loaded.store(true);
					return true;
				}

				if (!is_json_path(file_path)) {
					log_error("read(): file " + file_path.string() + " is not a .json file!");
					return false;
				}

				std::ifstream file(file_path);
				if (!file.is_open()) {
					throw std::runtime_error("cannot open json file: " + file_path.string());
				}

				std::stringstream buffer;
				buffer << file.rdbuf();

				auto json_parsed = boost::json::parse(buffer.str());
				if (!json_parsed.is_object()) {
					throw std::runtime_error("cannot load json, root is not an object!");
				}

				m_json = json_parsed.as_object();
				log_info("read(): successfully read configurations from " + file_path.string());
				m_loaded.store(true);
				return true;
			}
			catch (const std::exception& error) {
				log_error("read(): " + std::string(error.what()));
				return false;
			}
		}

		// Сохранение файла с pretty-print.
		bool save(const std::filesystem::path& file_path) const {
			if (!is_json_path(file_path)) {
				log_error("save(): file " + file_path.string() + " is not a .json file!");
				return false;
			}

			std::ofstream file(file_path);
			if (!file.is_open()) {
				log_error("save(): cannot write to " + file_path.string());
				return false;
			}

			std::ostringstream oss;
			pretty_print(oss, m_json);
			file << oss.str();
			return true;
		}

		// Добавить/заменить элемент по ключу. Перед записью отфильтровать
		// неизвестные поля (по списку allowed_fields()).
		bool add_json_item(const std::string& key, boost::json::object value) {
			try {
				const auto& allowed = allowed_fields();
				for (auto it = value.begin(); it != value.end(); ) {
					if (!allowed.contains(std::string(it->key()))) {
						log_warn("add_json_item(): drop unknown field " + std::string(it->key()));
						it = value.erase(it);
					}
					else {
						++it;
					}
				}

				m_json[key] = std::move(value);
				return true;
			}
			catch (const std::exception& error) {
				log_error("add_json_item(): " + std::string(error.what()));
				return false;
			}
		}

		/*
			Запись элемента как есть, без фильтра allowed_fields().

			Нужна там, где файлом владеет другая система и хранит в нём свои
			поля: фильтр вычистил бы их при первой же чужой записи. Вызывающий
			обязан сам собрать запись целиком.
		*/
		bool put_json_item(const std::string& key, boost::json::object value) {
			try {
				m_json[key] = std::move(value);
				return true;
			}
			catch (const std::exception& error) {
				log_error("put_json_item(): " + std::string(error.what()));
				return false;
			}
		}

		bool remove_json_item(const std::string& key) {
			try {
				if (!m_json.contains(key)) {
					return false;
				}
				m_json.erase(key);
				return true;
			}
			catch (const std::exception& error) {
				log_error("remove_json_item(): " + std::string(error.what()));
				return false;
			}
		}

		std::optional<boost::json::object> get_json_item(const std::string& key) const {
			try {
				auto it = m_json.find(key);
				if (it == m_json.end()) {
					throw std::runtime_error("key <" + key + "> not found in configurations");
				}
				if (!it->value().is_object()) {
					throw std::runtime_error("object with key <" + key + "> is not a json object");
				}
				return it->value().as_object();
			}
			catch (const std::exception& error) {
				log_error("get_json_item(): " + std::string(error.what()));
				return std::nullopt;
			}
		}

		bool is_exists(const std::string& key) const {
			if (m_json.find(key) == m_json.end()) {
				log_error("is_exists(): key <" + key + "> not found in configurations");
				return false;
			}
			return true;
		}

		// Прямой read-only доступ к корневому объекту — нужен наследникам.
		const boost::json::object& raw() const { return m_json; }

	protected:
		// Допустимые поля для add_json_item(). Каждый наследник возвращает свой набор.
		virtual const std::unordered_set<std::string>& allowed_fields() const = 0;

		// Хелперы логирования — чтобы не таскать if(m_logger) везде в наследниках.
		void log_info(const std::string& msg) const { if (m_logger) m_logger->info(class_tag() + msg); }
		void log_warn(const std::string& msg) const { if (m_logger) m_logger->warn(class_tag() + msg); }
		void log_error(const std::string& msg) const { if (m_logger) m_logger->error(class_tag() + msg); }
		void log_debug(const std::string& msg) const { if (m_logger) m_logger->debug(class_tag() + msg); }

		// Тэг для логов (типа "UJsonCalibrationConfiguration ").
		virtual std::string class_tag() const { return "UJsonReaderBase "; }

		static bool is_json_path(const std::filesystem::path& p) {
			return p.string().ends_with(".json");
		}

	protected:
		boost::json::object m_json;
		ULogger* m_logger;
		std::atomic<bool> m_loaded{ false };
	};

} // namespace varan