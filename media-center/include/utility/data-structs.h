#pragma once

#include <iostream>
#include <vector>
#include <map>
#include <optional>
#include <string>
#include <filesystem>

#include "utility/rtsp-url.h"

namespace varan {
namespace nvr {
	// Перечисления

	enum class EPipelineStatus {
		NONE = 0,
		PROBING = 1,
		INITIALIZED = 2,
		PLAYING = 3,
		STOPPED = 4,
		COUNT = 5
	};

	// Класс трубы, а не её назначение: что поток делает, решают назначения
	enum class EPilelineType {
		NONE = 0,
		CAMERA = 1,
		NV12_ENCODER = 2,
		CORRECTION = 3,
		COUNT = 4
	};

	// Назначение потока: какую ветку media-center поднимает поверх общего ствола
	enum class EStreamPurpose {
		VIEW = 0,
		RECORD = 1,
		NEURAL = 2,
		BIRDVIEW = 3,
		COUNT = 4
	};

	inline std::string purpose_to_string(EStreamPurpose purpose) {
		switch (purpose) {
		case EStreamPurpose::VIEW:     return "view";
		case EStreamPurpose::RECORD:   return "record";
		case EStreamPurpose::NEURAL:   return "neural";
		case EStreamPurpose::BIRDVIEW: return "birdview";
		default:                       return "";
		}
	}

	inline std::optional<EStreamPurpose> purpose_from_string(const std::string& name) {
		if (name == "view")     return EStreamPurpose::VIEW;
		if (name == "record")   return EStreamPurpose::RECORD;
		if (name == "neural")   return EStreamPurpose::NEURAL;
		if (name == "birdview") return EStreamPurpose::BIRDVIEW;
		return std::nullopt;
	}

	// Назначения потока; имена совпадают с именами модулей сборки
	struct FStreamPurposes {
		bool view = false;
		bool record = false;
		bool neural = false;
		bool birdview = false;

		bool has(EStreamPurpose purpose) const {
			switch (purpose) {
			case EStreamPurpose::VIEW:     return view;
			case EStreamPurpose::RECORD:   return record;
			case EStreamPurpose::NEURAL:   return neural;
			case EStreamPurpose::BIRDVIEW: return birdview;
			default:                       return false;
			}
		}

		void add(EStreamPurpose purpose) {
			switch (purpose) {
			case EStreamPurpose::VIEW:     view = true;     break;
			case EStreamPurpose::RECORD:   record = true;   break;
			case EStreamPurpose::NEURAL:   neural = true;   break;
			case EStreamPurpose::BIRDVIEW: birdview = true; break;
			default: break;
			}
		}

		bool empty() const { return !view && !record && !neural && !birdview; }

		// Кадры нужны только потребителям, просмотр и запись идут без декода
		bool needs_decode() const { return neural || birdview; }

		std::vector<std::string> names() const {
			std::vector<std::string> result;
			if (view)     result.push_back("view");
			if (record)   result.push_back("record");
			if (neural)   result.push_back("neural");
			if (birdview) result.push_back("birdview");
			return result;
		}

		std::string to_string() const {
			std::string result;
			for (const auto& name : names()) {
				if (!result.empty()) result += ",";
				result += name;
			}
			return result.empty() ? "none" : result;
		}
	};

	template <typename T>
	requires std::is_enum_v<T>&& requires { T::COUNT; }
	std::optional<T> int_to_count_enum(int value)
	{
		if (value < 0 ||
			value >= static_cast<int>(T::COUNT))
		{
			return std::nullopt;
		}

		return static_cast<T>(value);
	}

	// Общие данные пайплайна
	struct FPipelineData {
		std::string name;
		EPipelineStatus status;
		EPilelineType type;
		FStreamPurposes purposes;

		int width;
		int height;
		std::string codec;
		int fps;

		std::string rtsp_url;

		bool use_udp;
		int latency;
		int reconnect_time;

		std::string record_path;
		int segment_length;

		// Физический вход камеры и качество той же картинки
		int channel;
		int substream;
	};

	// Структуры для пайпалнов
	// Входные данные для пайплайна
	struct FPipelineConfig {
		std::string name = "unnamed";
		std::string camera_name;

		std::string rtsp_url;
		int channel = 1;
		int substream = 1;
		EPilelineType type = EPilelineType::CAMERA;
		FStreamPurposes purposes;

		int latency = 200;
		bool use_udp = false;
		int reconnect_delay = 10;

		std::filesystem::path record_path;
		int segment_length = 600;
	};

	// Стурктуры ждля камер
	struct FCameraData {
		std::string id;

		std::string display_name;
		std::string description;

		std::string ip_adress;
		std::string port;
		std::string user;
		std::string password;

		ERtspType production;
	};

	struct FCameraStreamsData {
		FCameraData camera;
		std::map<std::string, FPipelineData> pipelines;
	};

	struct FWebSocketOptions {
		std::string ip_adress;
		std::string port;
	};
}// namespace nvr
}// namespace varan