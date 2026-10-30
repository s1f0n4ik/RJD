#pragma once

#include <boost/json.hpp>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "logger.h"

namespace varan {

	// Запись через tmp + fsync + rename + fsync каталога; пустая строка — успех
	std::string write_durable(const std::filesystem::path& path, const std::string& data);

	// sha256 содержимого файла в hex; пусто — файл не читается
	std::string sha256_file(const std::filesystem::path& path);

	// Файл из кэша мастера на место, если там другой; replaced — файл заменён; пустая строка — успех
	std::string place_asset(const std::filesystem::path& dst, const std::string& sha256, bool& replaced);

	// Применение части пакета мастера; пустая строка — успех, иначе причина отказа
	using CConfigPartApplier = std::function<std::string(const boost::json::value& part)>;

	struct FConfigApplyResult {
		bool ok = false;
		std::string error;
		std::vector<std::string> missing_assets;
	};

	// Конфигурация платы, присланная мастером пакетом с ревизией
	class UMachineConfig {
	public:
		explicit UMachineConfig(ULogger::ELoggerLevel level = ULogger::ELoggerLevel::INFO);

		// Части применяются в порядке регистрации
		void register_part(const std::string& name, CConfigPartApplier applier);

		std::string revision() const;
		boost::json::object applied() const;

		std::filesystem::path asset_path(const std::string& sha256) const;
		bool has_asset(const std::string& sha256) const;
		std::string put_asset(const std::string& sha256, const std::string& body);

		FConfigApplyResult apply(const boost::json::object& package);

	private:
		mutable std::mutex m_mutex;
		std::vector<std::pair<std::string, CConfigPartApplier>> m_parts;
		boost::json::object m_applied;
		ULogger m_logger;
	};

} // varan
