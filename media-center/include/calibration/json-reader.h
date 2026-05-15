#pragma once
#include <iostream>
#include <fstream>
#include <filesystem>
#include <string>
#include <optional>
#include <unordered_set>

#include <boost/json.hpp>

#include "logger.h"
#include "constants.h"
#include "utility.h"

using namespace varan::calibration::constants;

namespace varan {
namespace calibration {
	
	/*
		Пример json:

		{
			{
				# Все поля могут сущестововать, а могут нет
				"<id>_<widht>_<height>": 
				{
					"id": "camera_01",
					"width": 1000,
					"height": 1000,

					#Калибровка
					"pattern_size": 25.0,
					"pattern_width": 9,
					"pattern_height": 6,
					"camera_matrix": объект json cv::Mat,
					"dist_coeffs": объект json cv::Mat,
					"rms": 1.0f,

					#Дисторсия
					"new_K": объект json cv::Mat,
					"undist_map_x": путь_к_файлу_с_весами,
					"undist_map_y": путь_к_файлу_с_весами,,

					# Варпинг
					"warp_map_x": путь_к_файлу_с_весами,
					"warp_map_y": путь_к_файлу_с_весами
				}
			},
		}
	*/

	const inline std::unordered_set<std::string> POSSIBLE_FIELDS = {
		JSON_ID, JSON_WIDTH, JSON_HEIGHT, JSON_PATTERN_SIZE, JSON_PATTERN_WIDTH, JSON_PATTERN_HEIGHT,
		JSON_CAMERA_MATRIX, JSON_DISTORTION_COEFFS, JSON_NEW_K, JSON_UNDISTORTION_MAP_X, JSON_UNDISTORTION_MAP_Y,
		JSON_WARP_MAP_X, JSON_WARP_MAP_Y
	};

	class UJsonReader {
	public:

		explicit UJsonReader(ULogger* logger = nullptr) : m_logger(logger) {};

		bool read(const std::filesystem::path& file_path) {
			try {
				if (m_loaded.load()) {
					return true;
				}
				if (!check_json(file_path)) {
					if (!file_path.parent_path().empty()) {
						std::filesystem::create_directories(file_path.parent_path());
					}

					m_json = boost::json::object{};
					std::ofstream create_file(file_path);
					if (!create_file.is_open()) {
						throw std::runtime_error("cannot create json file: " + file_path.string());
					}

					create_file << boost::json::serialize(m_json);
					if (m_logger) m_logger->warn("JsonReader(): json file not found, new created: " + file_path.string());
					m_loaded.store(true);

					return true;
				}
				else {
					std::ifstream file(file_path);
					if (!file.is_open()) {
						throw std::runtime_error("cannot open json file: " + file_path.string());
					}

					std::stringstream buffer;
					buffer << file.rdbuf();

					auto json_parsed = boost::json::parse(buffer.str());
					if (json_parsed.is_object()) {
						m_json = json_parsed.as_object();
						if (m_logger) m_logger->info("JsonReader read(): successfully read calibrator confgurations!");
						m_loaded.store(true);

						return true;
					}
					else {
						throw std::runtime_error("cannot load json, that isn't object!");
					}
				}
			}
			catch (const std::exception& error) {
				if (m_logger) m_logger->error("JsonReader read(): error: " + std::string(error.what()));
				return false;
			}
		};

		bool save(const std::filesystem::path& file_path) const {
			if (!check_json(file_path)) {
				return false;
			}

			std::ofstream file(file_path);
			if (!file.is_open()) {
				if (m_logger) m_logger->error("JsonReader save(): cannot write to " + file_path.string());
				return false;
			}

			file << boost::json::serialize(m_json);
		};

		bool add_json_item(const std::string& key, boost::json::object& value) {
			try {
				if (m_json.empty()) {
					m_json = boost::json::object{};
				}

				// Удаляем все неизвестные поля
				for (auto it = value.begin(); it != value.end(); ) {
					if (!POSSIBLE_FIELDS.contains(std::string(it->key()))) {
						if (m_logger) m_logger->warn("JsonReader save(): destroy unknown field " + std::string(it->key()));
						it = value.erase(it);
					}
					else {
						++it;
					}
				}

				m_json[key] = value;

				return true;
			}
			catch (const std::exception& error) {
				if (m_logger) {
					m_logger->error("JsonReader add_json_item(): " + std::string(error.what()));
				}
				return false;
			}
		};

		bool remove_json_item(const std::string& key) {
			try {
				if (!m_json.contains(key)) {
					return false;
				}

				m_json.erase(key);
				return true;
			}
			catch (const std::exception& error) {
				if (m_logger) {
					m_logger->error("JsonReader remove_json_item(): " + std::string(error.what()));
				}
				return false;
			}
		};

		boost::json::array get_cameras_info() const {
			boost::json::array result;
			try {
				for (const auto& [key, value] : m_json) {
					if (!value.is_object()) {
						continue;
					}

					const auto& obj = value.as_object();
					if (!contains_required_fields(obj)) continue;

					boost::json::object item;
					item[JSON_ID] = obj.at(JSON_ID);
					item[JSON_WIDTH] = obj.at(JSON_WIDTH);
					item[JSON_HEIGHT] = obj.at(JSON_HEIGHT);
					result.push_back(item);
				}
			}
			catch (const std::exception& error) {
				if (m_logger) m_logger->error("JsonReader get_cameras_info(): " + std::string(error.what()));
			}
			return result;
		};

		boost::json::object get_sender_json_item(const std::string& key) {
			boost::json::object result;
			try {
				if (!m_json.contains(key)) {
					if (m_logger) m_logger->debug("JsonReader get_sender_json_item(): json doesn't contain key=" + key);
					return result;
				}

				const auto& value = m_json.at(key);
				if (!value.is_object()) {
					if (m_logger) m_logger->debug("JsonReader get_sender_json_item(): json doesn't contain object at key=" + key);
					return result;
				}

				const auto& obj = value.as_object();
				if (!contains_required_fields(obj)) {
					return result;
				}
				result[JSON_ID] = obj.at(JSON_ID);
				result[JSON_WIDTH] = obj.at(JSON_WIDTH);
				result[JSON_HEIGHT] = obj.at(JSON_HEIGHT);

				auto is_pattern = contains_pattern_fileds(obj);
				result[JSON_IS_PATTERN] = is_pattern;
				if (is_pattern) {
					result[JSON_PATTERN_SIZE] = obj.at(JSON_PATTERN_SIZE);
					result[JSON_PATTERN_WIDTH] = obj.at(JSON_PATTERN_WIDTH);
					result[JSON_PATTERN_HEIGHT] = obj.at(JSON_PATTERN_HEIGHT);
				}

				auto is_calibration = contains_calibration_fields(obj);
				result[JSON_IS_PATTERN] = is_calibration;
				if (is_calibration) {
					result[JSON_RMS] = obj.at(JSON_RMS);
				}

				result[JSON_IS_UNDISTORTION] = contains_undistortion_fields(obj);
				return result;
			}
			catch (const std::exception& error) {
				if (m_logger)  m_logger->error("get_camera_info(): error " + std::string(error.what()));
				return {};
			}
		}

		std::optional<boost::json::object> get_json_item(const std::string& key) {
			try {
				auto it = m_json.find(key);
				if (it == m_json.end()) {
					throw std::runtime_error("Key <" + key + "> didn't find at configurations!");
				}

				if (!it->value().is_object()) {
					throw std::runtime_error("object with key <" + key + "> isn't json object!");
				}
				return it->value().as_object();
			}
			catch (const std::exception& error) {
				if (m_logger) m_logger->error("JsonReader get_json_item(): error " + std::string(error.what()));
				return std::nullopt;
			}
		}

		bool is_exists(std::string key) {
			if (m_json.find(key) == m_json.end()) {
				if (m_logger) m_logger->error("Key <" + key + "> didn't find at configurations!");
				return false;
			}
			return true;
		}

	public:

		static std::string get_item_key(std::string id, int width, int height) {
			return (std::ostringstream() << id << "_" << width << "_" << height).str();
		}

	private:

		bool check_json(const std::filesystem::path& file_path) const {
			if (!std::filesystem::exists(file_path)) {
				if (m_logger) m_logger->error("JsonReader read(): cannot read not existing json file: " + file_path.string());
				return false;
			}
			if (!file_path.string().ends_with(".json")) {
				if (m_logger) m_logger->error("JsonReader read(): file " + file_path.string() + " doesn't json!");
				return false;
			}
			return true;
		};

		bool contains_required_fields(const boost::json::object& obj) const {
			return
				obj.contains(JSON_ID) &&
				obj.contains(JSON_WIDTH) &&
				obj.contains(JSON_HEIGHT);
		}

		bool contains_pattern_fileds(const boost::json::object& obj) const {
			return
				obj.contains(JSON_PATTERN_SIZE) &&
				obj.contains(JSON_PATTERN_WIDTH) &&
				obj.contains(JSON_PATTERN_HEIGHT);
		}

		bool contains_calibration_fields(const boost::json::object& obj) const {
			return
				obj.contains(JSON_RMS) &&
				obj.contains(JSON_CAMERA_MATRIX) &&
				obj.contains(JSON_DISTORTION_COEFFS);
		}

		bool contains_undistortion_fields(const boost::json::object& obj) const {
			return
				obj.contains(JSON_NEW_K) &&
				obj.contains(JSON_UNDISTORTION_MAP_X) &&
				obj.contains(JSON_UNDISTORTION_MAP_Y);
		}

	private:
		boost::json::object m_json;
		ULogger* m_logger;

		std::atomic<bool> m_loaded = false;
	};

};
};
