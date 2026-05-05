#pragma once

#include <iostream>
#include <vector>
#include <map>
#include <string>
#include <filesystem>

#include "utility/rtsp-url.h"

namespace varan {
namespace nvr {
	// Перечисления

	enum class EPipelineStatus {
		NONE = 0,
		READY = 1,
		STOPPED = 2,
		PLAYING = 3,
		RESTARTING = 4,
		INITIALIZED = 5,
		COUNT = 6
	};

	enum class EPilelineType {
		NONE = 0,
		MAIN = 1,
		SUB = 2,
		NV12_ENCODER = 3,
		COUNT = 4
	};

	enum class ECameraType {
		NONE = 0,
		GENERAL = 1,
		NEURAL = 2,
		BIRDVIEW = 3,
		VIRTUAL = 4,
		COUNT = 5
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
	};

	// Структуры для пайпалнов
	// Входные данные для пайплайна
	struct FPipelineConfig {
		std::string name = "unnamed";
		std::string camera_name;

		std::string rtsp_url;
		int stream = 0;
		EPilelineType type;

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

		ECameraType type;
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