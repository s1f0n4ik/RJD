#pragma once

#include <iostream>
#include <vector>
#include <map>
#include <string>
#include <filesystem>

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
		COUNT = 3
	};

	enum class ECameraType {
		NONE = 0,
		GENERAL = 1,
		NEURAL = 2,
		BIRDVIEW = 3,
		COUNT = 4
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

	// Стурктуры ждля камер
	struct FCameraData {
		std::string name;
		std::string description;

		std::string ip_adress;
		std::string port;
		std::string user;

		ECameraType type;

		std::map<std::string, FPipelineData> pipelines;
	};

	// Структуры для пайпалнов

	// Входные данные для пайплайна
	struct FInputPipelineParameters {
		std::string name = "unnamed";
		std::string camera_name = "";

		std::string rtsp_url = ""; // полная ссылка с пользователем и паролем
		int latency = 200; // в милисекундах
		bool use_udp = false;
		int reconnect_delay = 10; // в секундах

		std::filesystem::path record_path = ""; // Путь для записи фрагментов
		int segment_length = 600; // Длительность сегмента в секундах
	};

	struct FWebSocketOptions {
		std::string ip_adress;
		std::string port;
	};
}// namespace nvr
}// namespace varan