#pragma once

#include <string>

#include <boost/json.hpp>

#include "video_pipeline.h"

namespace varan {
namespace neural {

	// Ответ клиенту от имени камеры: текст уйдет в сигналинг как есть,
	using CModuleReply = std::function<void(
		const std::string& client_id,
		bool successed,
		const std::string& type,
		const std::string& description,
		int code
	)>;

	struct FStreamClaim {
		bool claimed = false;
		UCameraPipeline* stream = nullptr;
	};

	// Абстракный ласс расширение для камер, дает дополнительную логику без создания очередного потомка
	class ICameraExtension {
	public:
		virtual ~ICameraExtension() = default;

		// Ключ, которым клиент просит поток этой надстройки
		virtual std::string stream_key() const = 0;

		// true — сообщение обработано, общий разбор не нужен
		virtual bool handle_message(
			const std::string& client_id,
			const std::string& type,
			const boost::json::object& message
		) = 0;

		virtual FStreamClaim select_stream(
			const std::string& client_id,
			const std::string& type,
			const boost::json::object& message
		) = 0;

		virtual void on_session_closed(const std::string& client_id, UCameraPipeline* stream) = 0;
	};

} // namespace neural
} // namespace varan
