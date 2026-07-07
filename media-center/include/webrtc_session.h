#pragma once

#include <string>
#include <functional>

#include <gst/gst.h>
#include <gst/webrtc/webrtc.h>
#include <boost/json.hpp>

#include "logger.h"

class UWebRTCSession {

	#define OFFER_TIMEOUT = 10; // Таймаут для организации соединенеия с клиентом

	using CSendMessage = std::function<void(const std::string& msg)>;
	using CRemoveSession = std::function<bool(const std::string& client_id, std::string& description)>;

public:
	UWebRTCSession(
		std::string client, 
		std::string camera, 
		bool is_sub, 
		GstElement* pipeline, 
		GstElement* tee, 
		CSendMessage send_callback, 
		CRemoveSession remove_callback, 
		ULogger* logger
	);

	~UWebRTCSession() = default;

	UWebRTCSession(const UWebRTCSession&) = delete;
	UWebRTCSession& operator=(const UWebRTCSession&) = delete;

	void teardown();

	bool create_branch(const std::string& codec);

	bool make_offer(const boost::json::object& message, std::string& description);

	bool create_answer(const boost::json::object& message, std::string& description);

	bool add_ice_candidate(const boost::json::object& message, std::string& description);

	boost::json::object make_json(bool successed, const std::string& type, const std::string& description);

	// Геттеры и сеттеры
	void send_message(const std::string& msg);

	void send_close_request(const std::string& msg, std::string& description);

	GstElement* get_webrtcbin_element();

	bool is_valid();

	std::string get_session_name();

	std::string get_client_id();

	void set_connected(bool is_connected);

	ULogger* get_logger();

	bool is_timeout_triggered() const;

private:
	std::string m_client_id;
	std::string m_camera_name;

	GstElement* m_pipeline = nullptr;
	GstElement* m_tee = nullptr;

	GstPad* m_tee_pad_src = nullptr;

	GstElement* m_queue = nullptr;
	GstElement* m_pay = nullptr;
	GstElement* m_webrtcbin = nullptr;

	CSendMessage m_send_callback;
	CRemoveSession m_remove_callback;

	ULogger* m_logger = nullptr;

	bool m_is_valid;
	bool m_is_sub;

	std::atomic<bool> m_is_connected{ false };
	std::atomic<bool> m_close_requested{ false };
	std::atomic<bool> m_offer_started{ false };

	guint m_connection_timeout_id{ 0 };
	std::atomic<bool> m_timeout_triggered{ false };

	static void on_negotiation_needed(GstElement* webrtcbin, gpointer data);

	static void on_offer_created(GstPromise* promise, gpointer data);

	static void on_ice_candidate(GstElement* webrtcbin, guint mlineindex, gchar* candidate, gpointer data);

	static void on_connection_state_changed(GObject* obj, GParamSpec*, gpointer user_data);

	static void on_connection_state_notify(GObject* object, GParamSpec*, gpointer user_data);

	static void on_ice_state_changed(GObject* obj, GParamSpec*, gpointer user_data);

	void start_offer_timeout();

	static gboolean on_connection_timeout(gpointer user_data);
	void cancel_connection_timeout();
};