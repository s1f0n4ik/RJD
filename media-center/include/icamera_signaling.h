#pragma once

#include <string>
#include <functional>

class ICameraSignaling {
public:
	using CSignalingCallback = std::function<void(const std::string& msg)>;

	virtual ~ICameraSignaling() = default;

	virtual void send_message(const std::string& message) = 0;

	virtual void on_signaling_message(const std::string& msg) = 0;

	virtual void set_signaling_callback(CSignalingCallback callback) = 0;
};